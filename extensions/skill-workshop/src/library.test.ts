import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  canonicalizePath,
  recordWorkshopChange,
} from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as libraryModule from "./library.js";
import { undoWorkshopReview, workshopReviewRunId } from "./review-undo.js";
import { getWorkshopRuntime, setWorkshopRuntime } from "./runtime.js";
import * as skillsRootModule from "./skills-root.js";
import { useWorkshopPluginScope, workshopPluginConfig } from "./test-support.js";
import * as unusedArchiveModule from "./unused-archive.js";

// Reading cron payloads is a host fact; the Gateway maintenance pin
// (src/gateway/server-maintenance.workshop-contract.test.ts) proves it against a real cron store.
const hostCron = vi.hoisted(() => ({ payloadText: "" }));
vi.mock("openclaw/plugin-sdk/skill-workshop-host-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/skill-workshop-host-runtime")>()),
  readCronPayloadText: async () => hostCron.payloadText,
}));

const { run, scoped } = useWorkshopPluginScope();
const lib = scoped(libraryModule);
const { resolveWorkshopSkillsDir } = scoped(skillsRootModule);
const { archiveUnusedWorkshopSkills } = scoped(unusedArchiveModule);

let state: OpenClawTestState;
let ctx: libraryModule.WorkshopMutationContext;
let liveSkillName: string;
const runId = "run-1";

const skill = (name: string, body: string, description = "Deploy staging builds") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  liveSkillName = "deploy";
  ctx = { config: {}, agentId: "main", actor: "agent", sessionKey: "agent:main:main", runId };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});

async function readLive(skillName = liveSkillName) {
  return (await lib.viewWorkshopSkill({}, "main", skillName)).content;
}
const create = (body: string, name = "deploy", description?: string) =>
  lib.createWorkshopSkill(ctx, { name, content: skill(name, body, description) });
const patch = (oldText: string, newText: string, context = ctx, skillName = liveSkillName) =>
  lib.patchWorkshopSkill(context, { name: skillName, oldText, newText });
const write = (filePath: string, content: string) =>
  lib.writeWorkshopSkillFile(ctx, { name: liveSkillName, filePath, content });
const view = (filePath?: string, versionId?: string) =>
  lib.viewWorkshopSkill({}, "main", liveSkillName, filePath, versionId);
const versions = () => lib.listWorkshopArchive({}, "main");
const liveNames = async () => (await lib.listWorkshopSkills({}, "main")).map(({ name }) => name);
const skillPath = (...parts: string[]) => path.join(resolveWorkshopSkillsDir({}, "main"), ...parts);
const restore = (context = ctx) => lib.restoreWorkshopSkill(context, { name: liveSkillName });
const archive = (absorbedInto?: string) =>
  lib.archiveWorkshopSkill(ctx, { name: liveSkillName, absorbedInto });
async function seed(name: string, content: string | Buffer) {
  const dir = skillPath(name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), content);
}
const refuses = (operation: Promise<unknown>, error: string | RegExp) =>
  expect(operation).rejects.toThrow(error);
function revokedAfter(allowed: number): libraryModule.WorkshopMutationContext {
  let checks = 0;
  return {
    ...ctx,
    assertLive: () => {
      if (++checks > allowed) {
        throw new Error("Learning is off.");
      }
    },
  };
}
async function createPatched() {
  await create("step 0");
  return patch("step 0", "step 1");
}

it.each(["later edit", "restore original", "recreate"] as const)(
  "undoes a review patch only on the same skill after %s",
  async (next) => {
    const name = liveSkillName;
    const file = "templates/checklist.txt";
    const user = { config: {}, agentId: "main", actor: "user" as const };
    const reviewRun = workshopReviewRunId("11111111-1111-4111-8111-111111111111");
    const review = { ...user, actor: "review" as const, runId: reviewRun };
    await lib.createWorkshopSkill(user, { name, content: skill(name, "Original instructions.") });
    await lib.writeWorkshopSkillFile(user, {
      name,
      filePath: file,
      content: "Original checklist.\n",
    });
    await lib.patchWorkshopSkill(review, {
      name,
      oldText: "Original instructions.",
      newText: "Reviewed instructions.",
    });
    if (next !== "later edit") {
      await lib.archiveWorkshopSkill(user, { name });
      if (next === "recreate") {
        await lib.createWorkshopSkill(user, { name, content: skill(name, "Later instructions.") });
      } else {
        await lib.restoreWorkshopSkill(user, { name });
      }
    } else {
      await lib.patchWorkshopSkill(user, {
        name,
        oldText: "Reviewed instructions.",
        newText: "Later instructions.",
      });
    }
    await lib.writeWorkshopSkillFile(user, { name, filePath: file, content: "Later checklist.\n" });
    const before = await lib.listWorkshopChanges("main", {});
    const result = await run(() => undoWorkshopReview(user, { runId: reviewRun }));

    if (next === "recreate") {
      expect(await readLive()).toBe(skill(name, "Later instructions."));
      expect((await view(file)).content).toBe("Later checklist.\n");
      expect(result).toEqual({ status: "already-undone", changes: [] });
      expect(await lib.listWorkshopChanges("main", {})).toEqual(before);
    } else {
      expect(await readLive()).toBe(skill(name, "Original instructions."));
      expect((await view(file)).content).toBe("Original checklist.\n");
      expect(result).toMatchObject({ status: "undone", changes: [{ action: "restore" }] });
    }
  },
);

it("reports unreadable skill files instead of returning an incomplete inventory", async () => {
  await seed("oversized", Buffer.alloc(1024 * 1024 + 1, "x"));
  await refuses(lib.listWorkshopSkills({}, "main"), /file exceeds limit of 1048576 bytes/);
});

it("lists broken frontmatter but prunes links, hidden and dependency trees before budgets", async () => {
  const content = "---\nname: [\n---\n";
  await fs.mkdir(skillPath("missing"), { recursive: true });
  await seed("broken", content);
  await fs.symlink(skillPath("broken"), skillPath("broken", "loop"), "dir");
  await fs.symlink(skillPath("broken", "SKILL.md"), skillPath("broken", "linked.md"), "file");
  await fs.mkdir(skillPath("broken", "references"));
  await fs.writeFile(skillPath("broken", "references", "kept.md"), "support");
  for (const ignored of [".git", ".venv", "node_modules"]) {
    const tooDeep = skillPath("broken", ignored, ...Array(65).fill("nested"));
    await fs.mkdir(tooDeep, { recursive: true });
    await fs.writeFile(path.join(tooDeep, "ignored.md"), "not skill content");
  }
  const files = ["SKILL.md", "references/kept.md"];
  expect(await lib.listWorkshopSkills({}, "main")).toMatchObject([
    { name: "broken", description: "", files, sizeBytes: Buffer.byteLength(content) + 7 },
  ]);
  expect((await lib.viewWorkshopSkill({}, "main", "broken")).files).toEqual(files);
});

it("refreshes changes after writes without sharing caller mutations", async () => {
  expect(await lib.listWorkshopChanges("main", { runId: "before" })).toEqual([]);

  await create("1. Deploy.");
  const changes = await lib.listWorkshopChanges("main", { runId });
  expect(changes).toMatchObject([{ action: "create", skillName: "deploy" }]);
  expect(changes[0]?.versionId).toBeUndefined();
  changes[0]!.summary = "caller mutation";
  expect(await lib.listWorkshopChanges("main", { beforeMs: changes[0]!.createdAtMs })).toEqual([]);
  expect(await lib.listWorkshopChanges("main", { runId })).toMatchObject([
    { summary: "created: Deploy staging builds" },
  ]);
});

it("versions and restores legacy names, including undoing an undo and an archive", async () => {
  const name = `deploy-${"staging-".repeat(8)}env`;
  liveSkillName = name;
  await seed(name, skill(name, "step 0"));
  await refuses(create("x", `${name}-copy`), /use 1-63 lowercase letters/);
  expect(await liveNames()).toEqual([name]);
  const patched = await lib.patchWorkshopSkill(ctx, {
    name,
    oldText: "step 0",
    newText: "step 1",
    summary: "custom",
  });
  expect(patched.versionId).toMatch(/^\d{8}T\d{9}Z-patch$/);
  const { actor, sessionKey } = ctx;
  expect(patched).toMatchObject({ actor, sessionKey, summary: "custom" });
  expect(await readLive()).toContain("step 1");
  const undo = await restore();
  expect(await readLive()).toContain("step 0");
  expect(undo.versionId).toMatch(/-restore$/);

  await restore();
  expect(await readLive()).toContain("step 1");
  expect(await lib.listWorkshopChanges("main", { runId: "other-run" })).toEqual([]);
  await create("1. Release.", "release");
  await write("references/hosts.md", "staging.example.test\n");

  await refuses(archive("missing"), /absorbed_into must name another live workshop skill/);
  const archived = await archive("release");
  expect(archived.summary).toBe("archived: merged into release");
  expect(await liveNames()).toEqual(["release"]);
  const [entry] = await versions();
  expect(entry).toMatchObject({ name, live: false });
  expect(entry?.versions[0]?.action).toBe("archive");
  await refuses(view(), /is archived/);

  await restore();
  expect(await view("references/hosts.md")).toMatchObject({
    content: "staging.example.test\n",
    files: ["SKILL.md", "references/hosts.md"],
  });
  expect(await readLive()).toContain("step 1");

  // The merge target stays locked, so archiving it first refuses the merge instead of racing.
  const [target, merge] = await Promise.allSettled([
    lib.archiveWorkshopSkill(ctx, { name: "release" }),
    archive("release"),
  ]);
  expect(target.status).toBe("fulfilled");
  expect(merge).toMatchObject({
    status: "rejected",
    reason: expect.any(lib.WorkshopWriteError),
  });
  expect(await liveNames()).toEqual([name]);
});

it.each(["user", "review"] as const)(
  "rechecks review membership after a queued same-name create by %s",
  async (actor) => {
    const name = liveSkillName;
    const content = skill(name, "Deploy the service.");
    const original = await lib.createWorkshopSkill({ ...ctx, actor: "review" }, { name, content });
    await archive();
    const user = { ...ctx, actor: "user" as const };
    const [replacement, undo] = await Promise.allSettled([
      lib.createWorkshopSkill({ ...ctx, actor }, { name, content }),
      lib.archiveWorkshopSkill(
        { ...user, undoReviewChange: { id: original.id, runId } },
        { name, reason: "undo" },
      ),
    ]);
    expect(replacement.status).toBe("fulfilled");
    if (actor === "review") {
      expect(undo).toMatchObject({ status: "fulfilled", value: { action: "archive" } });
      expect(await liveNames()).not.toContain(name);
    } else {
      expect(undo).toMatchObject({
        status: "rejected",
        reason: expect.any(lib.WorkshopWriteError),
      });
      expect(await readLive()).toBe(content);
      expect(await lib.listWorkshopChanges("main", { limit: 1 })).toMatchObject([
        { action: "create", actor: "user" },
      ]);
    }
  },
);

it("undoes an archived version restore without changing the default or losing its redo", async () => {
  const name = liveSkillName;
  const file = "references/notes.md";
  await create("instructions A");
  await write(file, "notes A\n");
  const older = await patch("instructions A", "instructions B");
  await write(file, "notes B\n");
  await archive();
  const history = await versions();

  const restoreId = (versionId: string | undefined) =>
    lib.restoreWorkshopSkill(ctx, { name, versionId });
  const undo = (undoRestoreChangeId: string) =>
    lib.archiveWorkshopSkill(ctx, { name, undoRestoreChangeId });
  const selected = await restoreId(older.versionId);
  const undone = await undo(selected.id);
  expect(await liveNames()).not.toContain(name);
  expect(await versions()).toEqual(history);
  expect(undone.versionId).toBe(older.versionId);
  const redone = await restoreId(undone.versionId);
  expect(await readLive()).toBe(skill(name, "instructions A"));
  expect((await view(file)).content).toBe("notes A\n");
  await refuses(undo(selected.id), /Refresh its history/);
  await fs.writeFile(skillPath(name, file), "locally edited\n");
  await refuses(undo(redone.id), /live files no longer match/);
  expect((await view(file)).content).toBe("locally edited\n");
  await fs.writeFile(skillPath(name, file), "notes A\n");
  await undo(redone.id);

  await restore();
  expect(await readLive()).toBe(skill(name, "instructions B"));
  expect((await view(file)).content).toBe("notes B\n");
  expect(await fs.readdir(skillPath(".archive"))).toEqual([name]);
});

it.each([
  { replaced: false, disconnected: false },
  { replaced: true, disconnected: false },
  { replaced: false, disconnected: true },
  { replaced: true, disconnected: true },
])(
  "preserves a save at undo detach (replacement: $replaced, disconnected: $disconnected)",
  async ({ replaced, disconnected }) => {
    const name = liveSkillName;
    const dir = skillPath(name);
    const file = "references/notes.md";
    await create("original");
    await write(file, "saved\n");
    await archive();
    const restored = await restore();
    const history = await versions();
    const request = new AbortController();
    let detached = "";
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from !== dir) {
        return rename(from, to);
      }
      await fs.writeFile(path.join(dir, file), "edited during undo\n");
      await rename(from, to);
      detached = String(to);
      if (replaced) {
        await fs.mkdir(path.join(dir, "references"), { recursive: true });
        await fs.writeFile(path.join(dir, "SKILL.md"), skill(name, "new live copy"));
        await fs.writeFile(path.join(dir, file), "new live notes\n");
      }
      if (disconnected) {
        request.abort();
      }
    });
    const inverse = lib.archiveWorkshopSkill(
      { ...ctx, assertLive: () => request.signal.throwIfAborted() },
      { name, undoRestoreChangeId: restored.id },
    );
    if (replaced) {
      if (disconnected) {
        await refuses(inverse, /retained at/);
        await refuses(inverse, path.relative(skillPath(), detached));
        expect(await fs.readFile(path.join(detached, file), "utf8")).toBe("edited during undo\n");
        expect(await versions()).toEqual(history);
      } else {
        await refuses(inverse, /saved as version/);
        const [archived] = await versions();
        expect((await view(file, archived?.versions[0]?.id)).content).toBe("edited during undo\n");
      }
      expect((await view(file)).content).toBe("new live notes\n");
      expect(await readLive()).toBe(skill(name, "new live copy"));
    } else {
      await refuses(inverse, /live files no longer match/);
      expect((await view(file)).content).toBe("edited during undo\n");
    }
    const expectedEntries = replaced && disconnected ? [name, path.basename(detached)] : [name];
    expect((await fs.readdir(skillPath(".archive"))).toSorted()).toEqual(
      expectedEntries.toSorted(),
    );
  },
);

it("refuses invalid or unsafe writes with actionable errors and leaves files untouched", async () => {
  await refuses(create("x", "Deploy"), /Invalid skill name/);
  await refuses(
    lib.createWorkshopSkill(ctx, { name: "deploy", content: skill("other", "x") }),
    /must contain "name: deploy"/,
  );
  await refuses(create("x", "deploy", "d".repeat(1025)), /description" must be 1-1024 bytes/);
  const token = `ghp_${"A".repeat(30)}`;
  await refuses(create(`export TOKEN=${token}`), /literal-secret.*placeholder/);
  await expect(fs.stat(skillPath("deploy"))).rejects.toMatchObject({ code: "ENOENT" });

  await create("run\nrun\nrun");
  await refuses(patch("run\nrun", "go"), /matches 2 places/);
  await expect(write("../escape.md", "x")).rejects.toBeInstanceOf(lib.WorkshopWriteError);
  await refuses(
    write(`references/${token}.md`, "x"),
    /file path in "deploy" looks like it contains a credential/,
  );
  await refuses(write("SKILL.md", "no frontmatter"), /must contain "name: deploy"/);
  const dependencyFile = "references/cache/node_modules/x.md";
  await refuses(write(dependencyFile, "x"), /node_modules.*not a skill support directory/);
  await expect(fs.stat(skillPath("deploy", dependencyFile))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect((await view()).files).toEqual(["SKILL.md"]);
  expect(await readLive()).toBe(skill("deploy", "run\nrun\nrun"));
  expect(await versions()).toEqual([]);
});

it("never lists or reads a symlinked saved version", async () => {
  await create("step 1");
  const outside = path.join(state.root, "outside");
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "SKILL.md"), "secret host file\n");
  const versionsDir = skillPath(".archive", "deploy");
  await fs.mkdir(versionsDir, { recursive: true });
  const id = "20260101T000000000Z-patch";
  await fs.symlink(outside, path.join(versionsDir, id));

  expect(await versions()).toEqual([]);
  await refuses(view(undefined, id), /has no version/);
});

it("refuses to restore a tampered saved version and leaves the live skill untouched", async () => {
  await create("step 1");
  const { versionId = "" } = await patch("step 1", "step 2");
  const versionDir = skillPath(".archive", "deploy", versionId);

  await fs.writeFile(path.join(versionDir, "SKILL.md"), "no frontmatter\n");
  await refuses(restore(), /Cannot restore "deploy".*must contain "name: deploy"/);
  await fs.writeFile(path.join(versionDir, "SKILL.md"), skill("deploy", "step 1"));
  await fs.mkdir(path.join(versionDir, "references"));
  await fs.writeFile(path.join(versionDir, "references", "env.md"), `TOKEN=ghp_${"A".repeat(30)}`);
  await refuses(restore(), /Cannot restore "deploy".*literal-secret/);
  await fs.rm(path.join(versionDir, "references", "env.md"));
  await fs.symlink("/etc/hosts", path.join(versionDir, "references", "hosts.md"));
  await refuses(restore(), /references\/hosts\.md is a symlink/);

  expect(await readLive("deploy")).toBe(skill("deploy", "step 2"));
  const [entry] = await versions();
  expect(entry?.versions.map((version) => version.id)).toEqual([versionId]);
});

it("keeps the newest ten versions per skill", async () => {
  await create("step 0");
  for (let step = 1; step <= 12; step += 1) {
    await patch(`step ${step - 1}`, `step ${step}`);
  }
  const [entry] = await versions();
  expect(entry?.versions).toHaveLength(10);
  const oldest = entry?.versions.at(-1)?.id ?? "";
  expect((await view(undefined, oldest)).content).toContain("step 2");
});

it.each(["patch", "archive"] as const)(
  "does not %s once authority is revoked during the snapshot",
  async (action) => {
    await create("step 0");
    // Live at lock time; revoked by the time the snapshot copy finishes.
    const revoking = revokedAfter(1);
    await refuses(
      action === "patch"
        ? patch("step 0", "step 1", revoking)
        : lib.archiveWorkshopSkill(revoking, { name: "deploy", reason: "unused" }),
      "Learning is off.",
    );
    expect(await readLive("deploy")).toContain("step 0");
    expect(await versions()).toEqual([]);
  },
);

it("keeps the live skill when restore is revoked between the swap's two renames", async () => {
  await createPatched();
  // Lock time, snapshot publish and the first swap check pass; the final publish is refused.
  await refuses(restore(revokedAfter(3)), "Learning is off.");
  expect(await readLive("deploy")).toContain("step 1");
});

it("retains the original live copy when restore publication and rollback both fail", async () => {
  await createPatched();
  const live = skillPath("deploy");
  let previous = "";
  const rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (from === live) {
      previous = String(to);
    } else if (to === live) {
      throw new Error(from === previous ? "rollback blocked" : "publication blocked");
    }
    await rename(from, to);
  });
  await refuses(restore(), "rollback blocked");
  expect(previous).toContain(".restore-previous-");
  expect(await fs.readFile(path.join(previous, "SKILL.md"), "utf8")).toBe(
    skill("deploy", "step 1"),
  );
});

it("keeps the archive receipt and its Undo when plugin keyed storage is unavailable", async () => {
  await create("before");
  await patch("before", "after");
  const runtime = run(() => getWorkshopRuntime());
  run(() =>
    setWorkshopRuntime({
      ...runtime,
      state: {
        ...runtime.state,
        openKeyedStoreV2: () => {
          throw new Error("Plugin keyed storage is unavailable.");
        },
      },
    }),
  );
  try {
    const archived = await archive();
    expect(archived.versionId).toEqual(expect.any(String));
    expect((await lib.listWorkshopChanges("main"))[0]?.id).toBe(archived.id);
    await lib.restoreWorkshopSkill(ctx, { name: liveSkillName, versionId: archived.versionId });
    expect(await readLive()).toContain("after");
  } finally {
    run(() => setWorkshopRuntime(runtime));
  }
});

describe("archiveUnusedWorkshopSkills", () => {
  const DAY_MS = 24 * 60 * 60_000;
  function agentConfig(runtime = "openclaw", sandbox?: "non-main"): OpenClawConfig {
    const defaults = {
      model: "anthropic/claude-test",
      models: { "anthropic/*": { agentRuntime: { id: runtime } } },
      ...(sandbox ? { sandbox: { mode: sandbox } } : {}),
    };
    return { agents: { defaults } };
  }
  const config = agentConfig();
  // Host facts the pass reads through the plugin runtime: the live config snapshot and recorded
  // skill use. The Gateway maintenance pin proves the real usage owner records and returns them.
  let liveConfig: OpenClawConfig;
  let usageTracked: boolean;
  let usage: Map<string, { useCount: number; lastUsedAtMs: number }>;
  const archiveUnused = (cfg = config, now = Date.now() + 31 * DAY_MS) =>
    archiveUnusedWorkshopSkills(cfg, "main", now);
  const createNamed = (name: string) => create("1. Do it.", name, `${name} steps`);
  beforeEach(() => {
    ctx = { config, agentId: "main", actor: "agent" };
    liveConfig = config;
    usageTracked = true;
    usage = new Map();
    hostCron.payloadText = "";
    run(() => {
      const runtime = getWorkshopRuntime();
      setWorkshopRuntime({
        ...runtime,
        config: { ...runtime.config, current: () => liveConfig },
        skills: {
          ...runtime.skills,
          readUsage: async () => ({ tracked: usageTracked, usage }),
        },
      });
    });
  });

  it("archives old unused skills, preserves used and cron-named ones, and allows undo", async () => {
    const createdAtMs = Date.now();
    for (const name of ["stale", "used", "scheduled", "scheduled-old"]) {
      await createNamed(name);
    }
    hostCron.payloadText = JSON.stringify({
      kind: "agentTurn",
      message: "Use the scheduled skill.",
    });
    expect(await archiveUnused(config, createdAtMs + 29 * DAY_MS)).toEqual([]);
    usage.set(canonicalizePath(skillPath("used", "SKILL.md")), {
      useCount: 1,
      lastUsedAtMs: createdAtMs + 20 * DAY_MS,
    });
    const archived = await archiveUnused(config, createdAtMs + 31 * DAY_MS);
    expect(archived.map((change) => change.skillName)).toEqual(["scheduled-old", "stale"]);
    expect(archived[0]).toMatchObject({
      action: "archive",
      actor: "curator",
      summary: "archived: unused for 30 days",
      versionId: expect.any(String),
    });
    expect(await liveNames()).toEqual(["scheduled", "used"]);
    await lib.restoreWorkshopSkill({ config, agentId: "main", actor: "user" }, { name: "stale" });
    expect(await liveNames()).toEqual(["scheduled", "stale", "used"]);
  });

  it.each(["before", "during"] as const)(
    "keeps a foreground support edit made %s the archive pass",
    async (when) => {
      const first = "apricot-a";
      const second = "apricot-b";
      const filePath = "references/note.md";
      await createNamed(first);
      await createNamed(second);
      const edit = (content: string) =>
        lib.writeWorkshopSkillFile(ctx, { name: second, filePath, content });
      await edit("original\n");
      const cutoff = Date.now() + 1;
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(cutoff + 20));

      if (when === "before") {
        await edit("updated\n");
      }
      let firstEvent = true;
      const handler = vi.fn(async (_event: unknown) => {
        if (firstEvent && when === "during") {
          firstEvent = false;
          await edit("updated\n");
        }
      });
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "skill_changed", handler }]),
      );
      try {
        const changes = await archiveUnused(config, cutoff + 30 * DAY_MS);
        expect(handler.mock.calls[0]?.[0]).toMatchObject({
          action: "removed",
          before: { skillKey: first },
        });
        expect(changes.map(({ skillName }) => skillName)).toEqual([first]);
        expect(await liveNames()).toEqual([second]);
        expect((await lib.viewWorkshopSkill(config, "main", second, filePath)).content).toBe(
          "updated\n",
        );
      } finally {
        resetGlobalHookRunner();
      }
    },
  );

  it("keeps a recent nested removal after its change leaves the agent feed", async () => {
    const removedPath = "references/nested/removed.md";
    await createNamed(liveSkillName);
    await write("references/kept.md", "keep this\n");
    await write(removedPath, "removed\n");
    const cutoff = Date.now() + 1;
    // The real filesystem clock must cross the cutoff before the unlink.
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(cutoff + 20));
    const removed = await lib.removeWorkshopSkillFile(ctx, {
      name: liveSkillName,
      filePath: removedPath,
    });
    const now = cutoff + 30 * DAY_MS;
    const recordPeerChange = (index: number) =>
      recordWorkshopChange({
        id: `peer-${index}`,
        agentId: "main",
        skillName: "peer",
        action: "patch",
        actor: "agent",
        summary: "updated peer",
        createdAtMs: removed.createdAtMs + index,
      });
    for (let i = 1; i <= 499; i++) {
      await recordPeerChange(i);
    }
    const feed = () => lib.listWorkshopChanges("main", { limit: 500 });
    expect((await feed()).at(-1)?.id).toBe(removed.id);
    expect(await archiveUnused(config, now)).toEqual([]);

    await recordPeerChange(500);
    expect((await feed()).map(({ id }) => id)).not.toContain(removed.id);
    expect(await archiveUnused(config, now)).toEqual([]);
    expect(await liveNames()).toEqual([liveSkillName]);
    expect(await view("references/kept.md")).toMatchObject({
      files: ["SKILL.md", "references/kept.md"],
      content: "keep this\n",
    });
  });

  it("distinguishes committed and refused removals in a legacy store with an evicted change", async () => {
    const filePath = "references/nested/guide.md";
    const names = ["committed", "refused"];
    for (const name of names) {
      await seed(name, skill(name, "do it"));
      await fs.mkdir(skillPath(name, "references", "nested"), { recursive: true });
      await fs.writeFile(skillPath(name, filePath), "guide\n");
    }
    const cutoff = Date.now() + 1;
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(cutoff + 20));
    for (const name of names) {
      // Save the real pre-mutation version without creating an activity row.
      await refuses(
        lib.removeWorkshopSkillFile(revokedAfter(2), { name, filePath }),
        "Learning is off.",
      );
    }
    // These are the two on-disk outcomes an older writer can leave after feed eviction.
    await fs.unlink(skillPath("committed", filePath));
    expect(await lib.listWorkshopChanges("main")).toEqual([]);
    const changes = await archiveUnused(config, cutoff + 30 * DAY_MS);
    expect(changes.map(({ skillName }) => skillName)).toEqual(["refused"]);
    expect(await liveNames()).toEqual(["committed"]);
  });

  it("archives a stale skill after a removal was revoked with its snapshot already saved", async () => {
    const filePath = "references/nested/kept.md";
    await createNamed(liveSkillName);
    await write(filePath, "keep this\n");
    const cutoff = Date.now() + 1;
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(cutoff + 20));
    await refuses(
      lib.removeWorkshopSkillFile(revokedAfter(2), { name: liveSkillName, filePath }),
      "Learning is off.",
    );
    const [archived] = await versions();
    expect(archived?.versions[0]?.action).toBe("remove_file");
    expect(archived?.versions[0]?.createdAtMs).toBeGreaterThan(cutoff);
    expect((await view(filePath)).content).toBe("keep this\n");
    const changes = await archiveUnused(config, cutoff + 30 * DAY_MS);
    expect(changes.map(({ skillName }) => skillName)).toEqual([liveSkillName]);
  });

  it.each(["runtime", "sandbox", "tracking", "learning"] as const)(
    "fails closed at the %s guard",
    async (guard) => {
      await createNamed("stale");
      const cfg = agentConfig(
        guard === "runtime" ? "codex" : "openclaw",
        guard === "sandbox" ? "non-main" : undefined,
      );
      if (guard === "tracking") {
        usageTracked = false;
      }
      if (guard === "learning") {
        liveConfig = workshopPluginConfig({ autonomous: { mode: "off" } }, config);
      }
      expect(await archiveUnused(cfg)).toEqual([]);
      expect(await liveNames()).toEqual(["stale"]);
    },
  );
});
