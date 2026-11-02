import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { handleGatewayRequest } from "../gateway/server-methods.js";
import type { GatewayRequestOptions } from "../gateway/server-methods/types.js";
import { prepareGatewaySkillAuthoring } from "../gateway/skill-library-authoring.js";
import { registerSkillsChangeListener } from "../skills/runtime/refresh-state.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { consumeRunSkillUsage } from "../skills/runtime/run-usage.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

let state: OpenClawTestState;
let config: OpenClawConfig;
let root: string;
const skill = (name: string, body = "Run the deployment.", description = "Deploy staging builds") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((part) => part.text ?? "").join("");

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "workshop-tool-contract-",
    prepareProfileCatalog: false,
  });
  config = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
  };
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  root = path.join(state.agentDir(), "workshop-skills");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeSkillsWatchers(true);
  await state.cleanup();
});

function tools(overrides: Partial<NonNullable<Parameters<typeof createOpenClawTools>[0]>> = {}) {
  return createOpenClawTools({
    config,
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    agentSessionKey: "agent:main:contract",
    runId: randomUUID(),
    ...overrides,
  });
}
function workshop(overrides: Parameters<typeof tools>[0] = {}) {
  const tool = tools(overrides).find((entry) => entry.name === "skill_workshop");
  expect(tool).toBeDefined();
  return tool!;
}
async function seed(name = "deploy", body?: string) {
  await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(path.join(root, name, "SKILL.md"), skill(name, body));
}
async function database<T>(use: (db: DatabaseSync) => T): Promise<T> {
  await closeSkillsWatchers(true);
  await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
  await closeStateDatabaseForTest();
  const db = new DatabaseSync(resolveOpenClawStateSqlitePath());
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    const result = use(db);
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}
async function changes() {
  const respond = vi.fn<GatewayRequestOptions["respond"]>();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "changes",
      method: "skills.workshop.changes",
      params: { agentId: "main", limit: 500 },
    },
    client: {
      connId: "contract",
      connect: {
        role: "operator",
        scopes: ["operator.read"],
        client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    },
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => config,
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestOptions["context"],
    respond,
  });
  expect(respond).toHaveBeenCalledOnce();
  const response = respond.mock.calls[0];
  assert.isDefined(response);
  expect(response[0]).toBe(true);
  return Value.Parse(
    Type.Object({
      changes: Type.Array(
        Type.Object({
          id: Type.String(),
          skillName: Type.String(),
          versionId: Type.Optional(Type.String()),
          action: Type.String(),
          actor: Type.String(),
          sessionKey: Type.Optional(Type.String()),
          runId: Type.Optional(Type.String()),
        }),
      ),
    }),
    response[1],
  );
}

describe("Workshop through the OpenClaw tool set", () => {
  it("T1 T6 L1: executes the public actions, preserves support trees, and explains undo", async () => {
    const tool = workshop();
    expect(tool.label).toBe("Skill Workshop");
    expect(text(await tool.execute("empty", { action: "list" }))).toBe(
      "No learned skills yet. Add one with action=create.",
    );
    await expect(tool.execute("bad", { action: "invent", name: "deploy" })).rejects.toThrow(
      'Unknown action "invent". Use list, view, create, patch, write_file, remove_file, archive, restore, draft, or discard.',
    );
    await seed("other");
    const created = text(
      await tool.execute("create", {
        action: "create",
        name: "deploy",
        content: skill("deploy", "Run the deployment. IMPORTANT"),
        reason: "remember deploy",
      }),
    );
    expect(created).toContain(
      'Created "deploy" (remember deploy). Undo with action=archive name=deploy.',
    );
    expect(created).toContain("Advisory (not blocking): cut no-op emphasis (IMPORTANT)");
    expect(created).toContain("- other: Deploy staging builds");
    expect(created).not.toContain("- deploy:");
    expect(await fs.readFile(path.join(root, "deploy", "SKILL.md"), "utf8")).toBe(
      skill("deploy", "Run the deployment. IMPORTANT"),
    );
    for (const folder of ["references", "templates", "scripts", "assets"]) {
      expect(
        text(
          await tool.execute(folder, {
            action: "write_file",
            name: "deploy",
            file_path: `${folder}/example.txt`,
            content: folder,
          }),
        ),
      ).toBe(
        `Updated "deploy" (wrote ${folder}/example.txt). Saved previous version; undo with action=restore name=deploy.`,
      );
      expect(await fs.readFile(path.join(root, "deploy", folder, "example.txt"), "utf8")).toBe(
        folder,
      );
    }
    expect(
      text(
        await tool.execute("patch", {
          action: "patch",
          name: "deploy",
          old_text: "deployment",
          new_text: "release",
          reason: "rename step",
        }),
      ),
    ).toBe(
      'Patched "deploy" (rename step). Saved previous version; undo with action=restore name=deploy.',
    );
    expect(text(await tool.execute("view", { action: "view", name: "deploy" }))).toContain(
      "Run the release.",
    );
    expect(
      text(
        await tool.execute("remove", {
          action: "remove_file",
          name: "deploy",
          file_path: "assets/example.txt",
        }),
      ),
    ).toContain('Updated "deploy" (removed assets/example.txt).');
    expect(
      text(await tool.execute("archive", { action: "archive", name: "deploy", reason: "retired" })),
    ).toBe(
      'Archived "deploy" (archived: retired). Saved previous version; undo with action=restore name=deploy.',
    );
    expect(text(await tool.execute("list", { action: "list" }))).toContain(
      "Archived (restore with action=restore):\n- deploy",
    );
    expect(text(await tool.execute("restore", { action: "restore", name: "deploy" }))).toContain(
      'Restored "deploy" (restored from archive).',
    );
    expect(await fs.readFile(path.join(root, "deploy", "references", "example.txt"), "utf8")).toBe(
      "references",
    );
    const restoredLive = await tool.execute("restore-live", { action: "restore", name: "deploy" });
    expect(text(restoredLive)).toBe(
      'Restored "deploy" (restored from archive). Saved previous version; undo with action=restore name=deploy.',
    );
    const snapshots = await fs.readdir(path.join(root, ".archive", "deploy"));
    expect(snapshots.map((entry) => entry.replace(/^\d{8}T\d{9}Z-/, "")).toSorted()).toEqual([
      "archive",
      "patch",
      "remove_file",
      "restore",
      "write_file",
      "write_file",
      "write_file",
      "write_file",
    ]);
    const beforeRestore = changeField(restoredLive.details, "versionId");
    expect(
      await fs.readFile(
        path.join(root, ".archive", "deploy", beforeRestore, "references", "example.txt"),
        "utf8",
      ),
    ).toBe("references");
  });

  it("T4 T5: review guards, attribution, and foreground-only live usage", async () => {
    await seed();
    await fs.mkdir(path.join(root, "deploy", "references"));
    await fs.writeFile(path.join(root, "deploy", "references", "old.txt"), "old");
    const runId = randomUUID();
    const reviewOf = "agent:main:telegram:direct:42";
    const options = {
      runId,
      agentSessionKey: "agent:main:internal-session-effects:review",
      skillWorkshop: { reviewOf },
    };
    const review = workshop(options);
    const actions = [
      { action: "patch", old_text: "deployment", new_text: "release" },
      { action: "write_file", file_path: "references/new.txt", content: "new" },
      { action: "remove_file", file_path: "references/old.txt" },
      { action: "archive", reason: "obsolete" },
    ];
    for (const action of actions) {
      await expect(review.execute("guard", { name: "deploy", ...action })).rejects.toThrow(
        "View it first",
      );
    }
    await review.execute("view", { action: "view", name: "deploy" });
    expect(consumeRunSkillUsage(runId)).toEqual([]);
    const retried = workshop(options);
    await expect(retried.execute("why", { action: "archive", name: "deploy" })).rejects.toThrow(
      "archive needs absorbed_into",
    );
    await retried.execute("patch", { name: "deploy", ...actions[0], reason: "correct step" });
    expect((await changes()).changes).toEqual([
      expect.objectContaining({ actor: "review", sessionKey: reviewOf, runId, action: "patch" }),
    ]);
    setRuntimeConfigSnapshot({ ...config, skills: { workshop: { autonomous: { mode: "off" } } } });
    await expect(retried.execute("off", { name: "deploy", ...actions[1] })).rejects.toThrow(
      "Learning is off; background reviews may not change skills.",
    );
    const foregroundId = randomUUID();
    const foreground = workshop({ runId: foregroundId });
    const version = (await fs.readdir(path.join(root, ".archive", "deploy")))[0];
    await foreground.execute("old", { action: "view", name: "deploy", version });
    expect(consumeRunSkillUsage(foregroundId)).toEqual([]);
    await foreground.execute("live", { action: "view", name: "deploy" });
    expect(consumeRunSkillUsage(foregroundId)).toEqual([
      expect.objectContaining({
        name: "deploy",
        source: "workspace",
        activation: "read",
        skillFile: await fs.realpath(path.join(root, "deploy", "SKILL.md")),
      }),
    ]);
  });

  it("T8: a propose-mode review saves drafts only; the foreground lists, views, and discards them", async () => {
    await seed();
    config = {
      ...config,
      skills: { ...config.skills, workshop: { autonomous: { mode: "propose" } } },
    };
    setRuntimeConfigSnapshot(config);
    const review = workshop({
      agentSessionKey: "agent:main:internal-session-effects:review",
      skillWorkshop: { reviewOf: "agent:main:telegram:direct:42" },
    });
    await review.execute("view", { action: "view", name: "deploy" });
    await expect(
      review.execute("patch", {
        action: "patch",
        name: "deploy",
        old_text: "deployment",
        new_text: "release",
        reason: "correct step",
      }),
    ).rejects.toThrow("Learning is in propose mode; save this change with action=draft instead.");
    const saved = await review.execute("draft", {
      action: "draft",
      name: "deploy",
      content: skill("deploy", "Run the release."),
      reason: "correct step",
    });
    const { draft: draftId } = Value.Parse(Type.Object({ draft: Type.String() }), saved.details);
    expect(draftId).toMatch(/^deploy-[0-9a-f]{8}$/);
    expect(text(saved)).toBe(
      `Saved draft ${draftId} for "deploy". Skills are unchanged; the user reviews drafts with /learn drafts.`,
    );
    expect(await fs.readFile(path.join(root, "deploy", "SKILL.md"), "utf8")).toBe(skill("deploy"));
    expect(await fs.readFile(path.join(root, ".drafts", draftId, "SKILL.md"), "utf8")).toBe(
      skill("deploy", "Run the release."),
    );
    expect((await changes()).changes).toEqual([]);
    await expect(review.execute("discard", { action: "discard", draft: draftId })).rejects.toThrow(
      "Background reviews may not discard drafts.",
    );

    const foreground = workshop();
    expect(text(await foreground.execute("list", { action: "list" }))).toBe(
      [
        "- deploy: Deploy staging builds",
        "Drafts waiting for review (view with action=view draft=<id>):",
        `- ${draftId} (deploy): correct step`,
      ].join("\n"),
    );
    expect(text(await foreground.execute("view", { action: "view", draft: draftId }))).toBe(
      `Draft ${draftId} for skill "deploy" (correct step):\n\n${skill("deploy", "Run the release.")}`,
    );
    expect(text(await foreground.execute("discard", { action: "discard", draft: draftId }))).toBe(
      `Discarded draft ${draftId}.`,
    );
    await expect(fs.stat(path.join(root, ".drafts", draftId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(root, "deploy", "SKILL.md"), "utf8")).toBe(skill("deploy"));
  });

  it.each([false, true])("T7: abort%s refuses file and feed effects", async (duringAwait) => {
    await seed();
    const tool = workshop();
    const abort = new AbortController();
    if (!duringAwait) {
      abort.abort(new Error("contract abort"));
    }
    const pending = tool.execute(
      "aborted",
      { action: "patch", name: "deploy", old_text: "deployment", new_text: "release" },
      abort.signal,
    );
    if (duringAwait) {
      abort.abort(new Error("contract abort"));
    }
    await expect(pending).rejects.toThrow("contract abort");
    expect(await fs.readFile(path.join(root, "deploy", "SKILL.md"), "utf8")).toBe(skill("deploy"));
    expect((await changes()).changes).toEqual([]);
    await expect(fs.stat(path.join(root, ".archive", "deploy"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("T7: captures the invoking source authority before its first await", async () => {
    await seed();
    const tool = workshop();
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:contract",
      receiptAuthority: () => false,
    };
    const pending = withGatewayToolCallerIdentity(identity, () => {
      const write = tool.execute("retired-source", {
        action: "patch",
        name: "deploy",
        old_text: "deployment",
        new_text: "release",
      });
      const caller = getGatewayToolCallerIdentity();
      if (!caller) {
        throw new Error("Expected the invoking caller scope");
      }
      caller.receiptAuthority = () => true;
      return write;
    });
    await expect(pending).rejects.toThrow("tool invocation authority is no longer active");
    expect(await fs.readFile(path.join(root, "deploy", "SKILL.md"), "utf8")).toBe(skill("deploy"));
    expect((await changes()).changes).toEqual([]);
  });

  it("L2 L3: retains ten prior trees and serves a feed with pruned-version references", async () => {
    const tool = workshop();
    await tool.execute("create", {
      action: "create",
      name: "deploy",
      content: skill("deploy", "step 0"),
    });
    const versions: string[] = [];
    for (let step = 1; step <= 12; step++) {
      const result = await tool.execute(`step-${step}`, {
        action: "patch",
        name: "deploy",
        old_text: `step ${step - 1}`,
        new_text: `step ${step}`,
      });
      const version = changeField(result.details, "versionId");
      expect(version).toMatch(/^\d{8}T\d{9}Z-patch$/);
      versions.push(version);
    }
    expect((await fs.readdir(path.join(root, ".archive", "deploy"))).toSorted()).toEqual(
      versions.slice(2).toSorted(),
    );
    expect(
      text(await tool.execute("oldest", { action: "view", name: "deploy", version: versions[2] })),
    ).toBe(skill("deploy", "step 2"));
    const feed = (await changes()).changes;
    expect(feed).toHaveLength(13);
    expect(feed).toContainEqual(
      expect.objectContaining({ versionId: versions[0], action: "patch" }),
    );
    await expect(
      tool.execute("pruned", { action: "view", name: "deploy", version: versions[0] }),
    ).rejects.toThrow("has no version");
    await expect(
      tool.execute("pruned-restore", { action: "restore", name: "deploy", version: versions[0] }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "deploy", "SKILL.md"), "utf8")).toBe(
      skill("deploy", "step 12"),
    );
  });

  it("L2: refuses symlinked and invalid saved versions without changing the live tree", async () => {
    await seed();
    const tool = workshop();
    const result = await tool.execute("patch", {
      action: "patch",
      name: "deploy",
      old_text: "deployment",
      new_text: "release",
    });
    const version = changeField(result.details, "versionId");
    const versionsDir = path.join(root, ".archive", "deploy");
    const outside = path.join(state.root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "SKILL.md"), "outside content");
    const linked = "20260101T000000000Z-patch";
    await fs.symlink(outside, path.join(versionsDir, linked));
    await expect(
      tool.execute("link", { action: "view", name: "deploy", version: linked }),
    ).rejects.toThrow("has no version");
    await expect(
      tool.execute("link-restore", { action: "restore", name: "deploy", version: linked }),
    ).rejects.toThrow();
    await fs.writeFile(path.join(versionsDir, version, "SKILL.md"), "no frontmatter\n");
    expect(
      text(await tool.execute("inspect-tampered", { action: "view", name: "deploy", version })),
    ).toBe("no frontmatter\n");
    await expect(
      tool.execute("tampered", { action: "restore", name: "deploy", version }),
    ).rejects.toThrow('Cannot restore "deploy"');
    expect(await fs.readFile(path.join(root, "deploy", "SKILL.md"), "utf8")).toBe(
      skill("deploy", "Run the release."),
    );
    await tool.execute("archive-for-list", { action: "archive", name: "deploy" });
    const listed = await tool.execute("list-versions", { action: "list" });
    expect(JSON.stringify(listed.details)).toContain(version);
    expect(JSON.stringify(listed.details)).not.toContain(linked);
  });

  it("L3 L4: refreshes discovery and caps persisted rows independently per agent", async () => {
    const tool = workshop();
    const events: string[] = [];
    const unsubscribe = registerSkillsChangeListener((event) => events.push(event.reason));
    try {
      await tool.execute("create", { action: "create", name: "deploy", content: skill("deploy") });
    } finally {
      unsubscribe();
    }
    expect(events).toContain("workshop");
    await database((db) => {
      const insert = db.prepare(
        "INSERT INTO skill_workshop_changes (cursor_id, change_id, agent_id, skill_name, action, actor, summary, version_id, session_key, run_id, created_at_ms) VALUES (?, ?, ?, 'deploy', 'patch', 'agent', 'old', NULL, NULL, NULL, ?)",
      );
      for (let index = 1; index <= 500; index++) {
        insert.run(index + 1, `old-${index}`, "main", index);
      }
      insert.run(502, "other-agent", "other", 1);
    });
    const result = await tool.execute("new", {
      action: "patch",
      name: "deploy",
      old_text: "deployment",
      new_text: "release",
      reason: "latest",
    });
    const id = changeField(result.details, "id");
    const feed = (await changes()).changes;
    expect(feed).toHaveLength(500);
    expect(feed).toContainEqual(expect.objectContaining({ id }));
    expect(feed.some((entry) => entry.id === "old-1" || entry.id === "old-2")).toBe(false);
    expect(
      await database((db) =>
        db
          .prepare(
            "SELECT agent_id, actor, summary, session_key, run_id, created_at_ms FROM skill_workshop_changes WHERE change_id = ?",
          )
          .get(id),
      ),
    ).toMatchObject({
      agent_id: "main",
      actor: "agent",
      summary: "latest",
      session_key: "agent:main:contract",
      run_id: expect.any(String),
      created_at_ms: expect.any(Number),
    });
    expect(
      await database((db) =>
        db
          .prepare("SELECT count(*) AS n FROM skill_workshop_changes WHERE agent_id = 'other'")
          .get(),
      ),
    ).toEqual({ n: 1 });
  });

  it("L5: validates new names, unsafe paths, overlapping patches, and manages legacy names", async () => {
    const tool = workshop();
    for (const name of ["", "A", "a".repeat(64)]) {
      await expect(
        tool.execute("invalid", { action: "create", name, content: skill(name) }),
      ).rejects.toThrow();
    }
    const longest = "a".repeat(63);
    await tool.execute("longest", { action: "create", name: longest, content: skill(longest) });
    const legacy = `legacy-${"a".repeat(64)}`;
    await seed(legacy, "run\nrun\nrun");
    expect(text(await tool.execute("list", { action: "list" }))).toContain(`- ${legacy}:`);
    await expect(
      tool.execute("overlap", {
        action: "patch",
        name: legacy,
        old_text: "run\nrun",
        new_text: "go",
      }),
    ).rejects.toThrow("matches 2 places");
    await expect(
      tool.execute("path", {
        action: "write_file",
        name: legacy,
        file_path: "../escape.md",
        content: "escape",
      }),
    ).rejects.toThrow('Use "SKILL.md" or a file like "references/notes.md"');
    await expect(
      tool.execute("absolute", {
        action: "write_file",
        name: legacy,
        file_path: path.join(state.root, "escape.md"),
        content: "escape",
      }),
    ).rejects.toThrow('Use "SKILL.md" or a file like "references/notes.md"');
    await tool.execute("legacy-patch", {
      action: "patch",
      name: legacy,
      old_text: "run\nrun\nrun",
      new_text: "go",
    });
    await tool.execute("legacy-archive", { action: "archive", name: legacy });
    await tool.execute("legacy-restore", { action: "restore", name: legacy });
    expect(await fs.readFile(path.join(root, legacy, "SKILL.md"), "utf8")).toBe(
      skill(legacy, "go"),
    );
    await expect(fs.stat(path.join(root, "escape.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [undefined, 40_000],
    [1, 1_024],
    [999_999, 200_000],
  ] as const)("L5: enforces maxSkillBytes %s as %s bytes", async (configured, limit) => {
    const boundedConfig: OpenClawConfig = {
      ...config,
      skills: {
        ...config.skills,
        workshop: configured === undefined ? {} : { maxSkillBytes: configured },
      },
    };
    const tool = workshop({ config: boundedConfig });
    const prefix = skill("bounded", "");
    const content = prefix + "x".repeat(limit - Buffer.byteLength(prefix));
    await tool.execute("at-limit", { action: "create", name: "bounded", content });
    await expect(
      tool.execute("over-limit", {
        action: "write_file",
        name: "bounded",
        file_path: "SKILL.md",
        content: content + "x",
      }),
    ).rejects.toThrow(`the limit is ${limit}. Keep SKILL.md to the procedure`);
    expect(await fs.readFile(path.join(root, "bounded", "SKILL.md"), "utf8")).toBe(content);
  });

  it.each([false, true])(
    "T2 T3: host-issued capability routes personal operations (multiple profiles: %s)",
    async (multiple) => {
      expect(tools({ sandboxed: true }).some((tool) => tool.name === "skill_workshop")).toBe(false);
      const alice = ensureProfileForEmail("alice@example.test");
      if (multiple) {
        ensureProfileForEmail("bob@example.test");
      }
      const catalog = await prepareUserProfileCatalog();
      const owner = {
        client: {
          authenticatedUserProfile: { profileId: alice.id },
          connect: { scopes: ["operator.admin"] },
        },
        context: { getRuntimeConfig: () => config },
      } as Parameters<typeof prepareGatewaySkillAuthoring>[0];
      const capability = await prepareGatewaySkillAuthoring(owner, "agent:main:contract", true);
      expect(capability?.defaultTarget).toBe(multiple ? "personal" : "workspace");
      const admission = prepareSystemAgentRunAdmission(
        config,
        randomUUID(),
        "main",
        "workshop-contract",
      );
      try {
        const admitted = await admission.admit("embedded");
        capability!.bind(admitted);
        const tool = workshop({ sandboxed: true, skillWorkshop: { libraryAuthoring: capability } });
        const invoke = (args: Record<string, unknown>) =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: "agent:main:contract",
              operationalRunInstance: admitted.operationalRunInstance,
              receiptAuthority: () => true,
            },
            () => tool.execute("personal", args),
          );
        if (!multiple) {
          await invoke({ action: "create", name: "workspace", content: skill("workspace") });
          expect(await fs.readFile(path.join(root, "workspace", "SKILL.md"), "utf8")).toBe(
            skill("workspace"),
          );
        }
        const personal = multiple ? {} : { target: "personal" };
        const receipt = await invoke({
          ...personal,
          action: "create",
          name: "personal",
          proposal_content: skill("personal"),
        });
        expect(receipt.details).toMatchObject({
          state: "published",
          target: "personal",
          entry: { ownerProfileId: alice.id },
        });
        const listing = await invoke({ ...personal, action: "list" });
        expect(text(listing)).toContain("personal");
        await expect(
          invoke({ target: "personal", action: "view", name: "personal" }),
        ).rejects.toThrow("Invalid personal Skill Workshop arguments");
        await expect(fs.stat(path.join(root, "personal"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        admission.close();
        catalog.release();
      }
    },
  );
});

function changeField(details: unknown, key: "id" | "versionId"): string {
  if (!details || typeof details !== "object" || !("change" in details)) {
    throw new Error("Expected a committed change");
  }
  const change = details.change;
  if (!change || typeof change !== "object" || !(key in change)) {
    throw new Error(`Expected change ${key}`);
  }
  const value =
    key === "id"
      ? "id" in change
        ? change.id
        : undefined
      : "versionId" in change
        ? change.versionId
        : undefined;
  if (typeof value !== "string") {
    throw new Error(`Expected string change ${key}`);
  }
  return value;
}
