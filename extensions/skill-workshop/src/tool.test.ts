import fs from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { listWorkshopChanges } from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as library from "./library.js";
import { setWorkshopRuntime } from "./runtime.js";
import * as skillsRoot from "./skills-root.js";
import { useWorkshopPluginScope } from "./test-support.js";
import { createSkillWorkshopTool, type SkillWorkshopToolOptions } from "./tool.js";

const { run, scoped } = useWorkshopPluginScope();
const { listWorkshopArchive } = scoped(library);
const { resolveWorkshopDraftsDir } = scoped(skillsRoot);
let runtimeConfig: OpenClawConfig = {};
const recordUsed = vi.fn<PluginRuntime["skills"]["recordUsed"]>(() => true);
const setRuntimeConfigSnapshot = (config: OpenClawConfig) => {
  runtimeConfig = config;
};
const workshopPluginConfig = (settings: Record<string, unknown>): OpenClawConfig => ({
  plugins: { entries: { "skill-workshop": { config: settings } } },
});

let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  setRuntimeConfigSnapshot({});
  recordUsed.mockClear();
  // Only the facades the tool reads; the plugin sets the real runtime in register(api).
  // Set inside the plugin scope so the stub replaces the loaded instance's runtime slot.
  run(() =>
    setWorkshopRuntime({
      config: { current: () => runtimeConfig },
      skills: { recordUsed },
    } as unknown as PluginRuntime),
  );
  await workshop()("create", {
    content: "---\nname: deploy\ndescription: Deploy staging\n---\n\n1. Run make deploy.\n",
  });
});

afterEach(async () => {
  await state.cleanup();
});

const patch = { old_text: "make deploy", new_text: "make ship" };
const supportFile = { file_path: "references/old.md", content: "stale notes\n" };

function workshop(options: Omit<SkillWorkshopToolOptions, "config" | "agentId"> = {}) {
  // Tools are built and run inside the plugin scope, as the host does for plugin tools.
  const tool = run(() => createSkillWorkshopTool({ config: {}, agentId: "main", ...options }));
  return async (action: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const result = await run(() =>
      tool.execute(action, { action, name: "deploy", ...params }, signal),
    );
    return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  };
}

describe("skill_workshop", () => {
  it("requires viewing an existing skill before a background run edits or archives it", async () => {
    const tool = workshop({ runId: "review-run", reviewOf: "agent:main:main" });

    await expect(tool("patch", patch)).rejects.toThrow("View it first");
    // Retries rebuild the tool inside the same run; the read must carry over.
    await tool("view");
    const retried = workshop({
      sessionKey: "agent:main:internal-session-effects:skill-workshop-review_1",
      runId: "review-run",
      reviewOf: "agent:main:telegram:direct:42",
    });
    await retried("patch", { ...patch, reason: "renamed target" });
    await expect(retried("archive")).rejects.toThrow(/archive needs absorbed_into .* or a reason/);

    expect(recordUsed).not.toHaveBeenCalled();
    // Changes credit the conversation the review learned from, not its internal session.
    expect(await listWorkshopChanges("main", { runId: "review-run" })).toMatchObject([
      {
        action: "patch",
        actor: "review",
        summary: "renamed target",
        sessionKey: "agent:main:telegram:direct:42",
      },
    ]);
  });

  it("gates remove_file behind a prior view in background runs", async () => {
    await workshop()("write_file", supportFile);
    const tool = workshop({ runId: "review-remove-run", reviewOf: "agent:main:main" });
    const remove = { file_path: supportFile.file_path };
    await expect(tool("remove_file", remove)).rejects.toThrow("View it first");
    // Reading an old saved version is not reading the live skill it would edit.
    const [entry] = await listWorkshopArchive({}, "main");
    await tool("view", { version: entry?.versions[0]?.id });
    await expect(tool("remove_file", remove)).rejects.toThrow("View it first");
    await tool("view");
    expect(await tool("remove_file", remove)).toContain('Updated "deploy"');
  });

  it("does not write once the invoking run is aborted", async () => {
    const aborted = AbortSignal.abort(new Error("run aborted"));
    await expect(workshop()("patch", patch, aborted)).rejects.toThrow("run aborted");
    expect(await listWorkshopChanges("main", {})).toHaveLength(1);
  });
  it("removes one support file as an undoable change and never removes SKILL.md", async () => {
    const tool = workshop({ runId: "fg-run" });
    await tool("write_file", supportFile);

    await expect(tool("remove_file", { file_path: "SKILL.md" })).rejects.toThrow(
      "SKILL.md cannot be removed. Archive the skill",
    );
    await expect(tool("remove_file", { file_path: "references/nope.md" })).rejects.toThrow(
      "references/nope.md does not exist",
    );

    await tool("remove_file", { file_path: supportFile.file_path });
    expect(await tool("view")).not.toContain("references/old.md");
    expect(recordUsed.mock.calls).toEqual([
      [expect.objectContaining({ skillName: "deploy", skillSource: "workspace" })],
    ]);

    await tool("restore");
    expect(await tool("view", { file_path: supportFile.file_path })).toContain("stale notes\n");
    expect((await listWorkshopChanges("main", { runId: "fg-run" })).map((c) => c.action)).toEqual([
      "restore",
      "remove_file",
      "write_file",
    ]);
  });
  it("shows what a whole-file SKILL.md rewrite or draft drops from the live skill", async () => {
    const tool = workshop();
    const steps = (section: string) => `## ${section}\n${"1. Do the step.\n".repeat(20)}`;
    await tool("write_file", {
      file_path: "SKILL.md",
      content: `---\nname: deploy\ndescription: Deploy staging\n---\n\n${["Build", "Ship", "Verify"].map(steps).join("\n")}`,
    });
    // A change note sent as the whole file: it applies, and the result says what it dropped.
    const note =
      "---\nname: deploy\ndescription: Deploy staging\n---\n\n# Fix: verify after ship\n\n## Why this exists\nCheck health.\n";
    const drafted = await tool("draft", { content: note });
    expect(drafted).toContain("SKILL.md body: 65 → 4 lines (-94%).");
    const id = /Saved draft (\S+) for "deploy"/.exec(drafted)?.[1];
    expect(await tool("view", { draft: id })).toContain(
      'Removed sections: "## Build", "## Ship", "## Verify".',
    );

    const written = await tool("write_file", { file_path: "SKILL.md", content: note });
    expect(written.split("\n")).toEqual([
      expect.stringMatching(/^Updated "deploy"/),
      "SKILL.md body: 65 → 4 lines (-94%).",
      'Removed sections: "## Build", "## Ship", "## Verify".',
      expect.stringMatching(
        /^Advisory \(not blocking\): the new SKILL\.md body is 6% of the previous/,
      ),
      expect.stringMatching(
        /^Advisory \(not blocking\): title "# Fix: verify after ship" reads as a change note/,
      ),
    ]);
  });

  it("saves a background review's change as a draft in propose mode and leaves skills unchanged", async () => {
    setRuntimeConfigSnapshot(workshopPluginConfig({ autonomous: { mode: "propose" } }));
    const review = workshop({ runId: "propose-run", reviewOf: "agent:main:main" });
    await review("view");
    await expect(review("patch", patch)).rejects.toThrow(
      "Learning is in propose mode; save this change with action=draft instead.",
    );
    const drafted = await review("draft", {
      content: "---\nname: deploy\ndescription: Deploy staging\n---\n\n1. Run make ship.\n",
      reason: "target was renamed",
    });
    const id = /Saved draft (\S+) for "deploy"/.exec(drafted)?.[1];
    expect(id).toBeDefined();
    await expect(review("discard", { draft: id })).rejects.toThrow(
      "Background reviews may not discard drafts.",
    );
    expect(await review("view")).toContain("1. Run make deploy.");
    expect(await listWorkshopChanges("main", { runId: "propose-run" })).toEqual([]);

    // A foreground /learn drafts turn finds, reads, and clears the draft.
    const foreground = workshop();
    expect(await foreground("list")).toContain(`- ${id} (deploy): target was renamed`);
    expect(await foreground("view", { draft: id })).toContain("1. Run make ship.");
    expect(await foreground("discard", { draft: id })).toBe(`Discarded draft ${id}.`);
    expect(await foreground("list")).not.toContain("Drafts waiting");
  });

  it("stops draft saves and discards whose run is aborted while they prepare", async () => {
    const content = "---\nname: deploy\ndescription: Deploy staging\n---\n\n1. Run make ship.\n";
    const draftsDir = resolveWorkshopDraftsDir({}, "main");
    const draftIds = async () =>
      (await fs.readdir(draftsDir).catch(() => [] as string[])).toSorted((a, b) =>
        a.localeCompare(b),
      );

    // The call captures the run's authority, then awaits; the abort lands before any file effect.
    const saving = new AbortController();
    const save = workshop()("draft", { content }, saving.signal);
    saving.abort(new Error("run aborted"));
    await expect(save).rejects.toThrow("run aborted");
    expect(await draftIds()).toEqual([]);

    const id = /Saved draft (\S+) for/.exec(await workshop()("draft", { content }))?.[1];
    const discarding = new AbortController();
    const discard = workshop()("discard", { draft: id }, discarding.signal);
    discarding.abort(new Error("run aborted"));
    await expect(discard).rejects.toThrow("run aborted");
    expect(await draftIds()).toEqual([id]);
  });

  it("shows the other learned skills on create so the agent can merge duplicates", async () => {
    const result = await workshop()("create", {
      name: "staging-deploy",
      content: "---\nname: staging-deploy\ndescription: Deploy to staging\n---\n\n1. Run it.\n",
    });
    expect(result).toContain('Created "staging-deploy"');
    expect(result).toContain("- deploy: Deploy staging");
    expect(result).not.toContain("- staging-deploy:");
  });
});
