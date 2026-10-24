import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import {
  upsertSessionEntryCore,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolveBootstrapContextForDiagnostics } from "./bootstrap-files-diagnostics.js";
import {
  FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
  hasCompletedBootstrapTurn,
  makeBootstrapWarn,
  resolveBootstrapContextForRun,
  resolveBootstrapFilesForRun,
  resolveContextInjectionMode,
} from "./bootstrap-files.js";
import { buildBootstrapContextFiles } from "./embedded-agent-helpers/bootstrap.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { SessionManager } from "./sessions/session-manager.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { mergeWorkspaceSetupState } from "./workspace-state-store.js";
import {
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_USER_FILENAME,
  loadExtraBootstrapFilesWithDiagnostics,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const memoryRuntimeMocks = vi.hoisted(() => ({ classifyWorkspacePaths: vi.fn() }));

vi.mock("../plugins/memory-runtime.js", () => ({
  classifyActiveMemoryWorkspacePaths: (...args: unknown[]) =>
    memoryRuntimeMocks.classifyWorkspacePaths(...args),
}));

let testState: OpenClawTestState | undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function registerFilesHook(
  files: (context: AgentBootstrapHookContext) => WorkspaceBootstrapFile[],
) {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [...context.bootstrapFiles, ...files(context)];
  });
}

function bootstrapFile(name: WorkspaceBootstrapFile["name"], filePath: string, content: string) {
  return { name, path: filePath, content, missing: false };
}

function registerNamedBootstrapFileHook(
  relativePath = "MEMORY.md",
  name: WorkspaceBootstrapFile["name"] = "MEMORY.md",
  content = "hook memory",
) {
  registerFilesHook(({ workspaceDir }) => [
    bootstrapFile(name, path.join(workspaceDir, relativePath), content),
  ]);
}

function registerLoadedBootstrapFilesHook(
  relativePaths: string[],
  name?: WorkspaceBootstrapFile["name"],
) {
  registerInternalHook("agent:bootstrap", async (event) => {
    const context = event.context as AgentBootstrapHookContext;
    const { files } = await loadExtraBootstrapFilesWithDiagnostics(
      context.workspaceDir,
      relativePaths,
    );
    if (name) {
      for (const file of files) {
        file.name = name;
      }
    }
    context.bootstrapFiles = [...context.bootstrapFiles, ...files];
  });
}

async function createDirectoryAlias(workspaceDir: string, targetDir: string, aliasName: string) {
  const aliasDir = path.join(workspaceDir, aliasName);
  await fs.symlink(targetDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
  return aliasDir;
}

async function writeFiles(workspaceDir: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      const filePath = path.join(workspaceDir, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    }),
  );
}

async function workspace(files: Record<string, string> = {}) {
  const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
  await writeFiles(workspaceDir, files);
  return workspaceDir;
}

async function writeCompletedWorkspaceState(workspaceDir: string): Promise<void> {
  await mergeWorkspaceSetupState(workspaceDir, {
    bootstrapSeededAt: "2026-05-16T00:00:00.000Z",
    setupCompletedAt: "2026-05-16T00:00:01.000Z",
  });
}

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(async () => {
    clearInternalHooks();
    resetLegacyWorkspaceStateCheckForTest();
    memoryRuntimeMocks.classifyWorkspacePaths
      .mockReset()
      .mockResolvedValue({ status: "unavailable" });
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-bootstrap-state-",
    });
  });

  it.each([
    {
      policy: "excludes lower-trust root memory before hooks but preserves trusted user context",
      result: {
        status: "classified",
        classifications: [
          { relativePath: DEFAULT_MEMORY_FILENAME, originClass: "untrusted" },
          { relativePath: DEFAULT_USER_FILENAME, originClass: "owner" },
        ],
      },
      allowed: [DEFAULT_USER_FILENAME],
      excluded: [DEFAULT_MEMORY_FILENAME],
      hook: true,
    },
    {
      policy: "fails closed for an omitted root classification",
      result: {
        status: "classified",
        classifications: [{ relativePath: DEFAULT_MEMORY_FILENAME, originClass: "agent" }],
      },
      allowed: [DEFAULT_MEMORY_FILENAME],
      excluded: [DEFAULT_USER_FILENAME],
    },
    {
      policy: "excludes root memory when the selected runtime lacks provenance support",
      result: { status: "unsupported" },
      allowed: [],
      excluded: [DEFAULT_MEMORY_FILENAME, DEFAULT_USER_FILENAME],
    },
  ])("$policy", async ({ result, allowed, excluded, hook }) => {
    const workspaceDir = await workspace({
      "MEMORY.md": "tainted memory",
      "USER.md": "trusted user",
    });
    if (hook) {
      registerNamedBootstrapFileHook(DEFAULT_MEMORY_FILENAME);
    }
    memoryRuntimeMocks.classifyWorkspacePaths.mockResolvedValue(result);
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {},
      agentId: "main",
      warn: (message) => warnings.push(message),
    });
    const names = files.map((file) => file.name);
    for (const name of allowed) {
      expect(names).toContain(name);
    }
    for (const name of excluded) {
      expect(names).not.toContain(name);
    }
    if (result.status === "unsupported") {
      expect(warnings).toContain(
        "excluding automatic memory context: selected memory runtime does not support provenance classification",
      );
    }
  });
  afterEach(async () => {
    clearInternalHooks();
    closeOpenClawStateDatabaseForTest();
    resetLegacyWorkspaceStateCheckForTest();
    await testState?.cleanup();
    testState = undefined;
  });

  it("drops malformed hook files with missing/invalid paths", async () => {
    registerFilesHook(
      ({ workspaceDir }) =>
        [
          {
            name: "EXTRA.md",
            filePath: path.join(workspaceDir, "BROKEN.md"),
            content: "broken",
            missing: false,
          },
          { name: "EXTRA.md", path: 123, content: "broken", missing: false },
          { name: "EXTRA.md", path: "   ", content: "broken", missing: false },
        ] as unknown as WorkspaceBootstrapFile[],
    );

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      warn: (message) => warnings.push(message),
    });

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "BOOTSTRAP.md",
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('missing or invalid "path" field');
  });

  it("dedupes hook-injected bootstrap paths relative to the workspace", async () => {
    registerFilesHook(({ workspaceDir }) => [
      bootstrapFile("AGENTS.md", "AGENTS.md", "duplicate relative hook content"),
      bootstrapFile(
        "AGENTS.md",
        path.join(workspaceDir, ".", "AGENTS.md"),
        "duplicate absolute hook content",
      ),
    ]);

    const workspaceDir = await workspace({ "AGENTS.md": "workspace rules" });
    const agentsPath = path.join(workspaceDir, "AGENTS.md");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const agentsFiles = files.filter((file) => file.path === agentsPath);

    expect(agentsFiles.map((file) => file.content)).toEqual(["workspace rules"]);

    const context = await resolveBootstrapContextForRun({ workspaceDir });
    const agentsContextFiles = context.contextFiles.filter((file) => file.path === agentsPath);
    expect(agentsContextFiles.map((file) => file.content)).toEqual(["workspace rules"]);
  });

  it("refreshes USER.md on every turn for long-lived sessions", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const userPath = path.join(workspaceDir, "USER.md");
    const sessionKey = `agent:main:webchat:direct:${randomUUID()}`;
    await fs.writeFile(userPath, "Prefer concise answers.", "utf8");
    const first = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

    await fs.writeFile(userPath, "Prefer detailed answers.", "utf8");
    const second = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

    expect(first.find((file) => file.name === "USER.md")?.content).toBe("Prefer concise answers.");
    expect(second.find((file) => file.name === "USER.md")?.content).toBe(
      "Prefer detailed answers.",
    );
  });

  it("ignores stale root BOOTSTRAP.md for home-relative workspace paths", async () => {
    registerNamedBootstrapFileHook("BOOTSTRAP.md", "BOOTSTRAP.md", "stale ritual");
    const parentDir = await makeTempWorkspace("openclaw-bootstrap-home-");
    const workspaceDir = path.join(parentDir, "workspace");
    await writeFiles(workspaceDir, { "AGENTS.md": "rules", "BOOTSTRAP.md": "stale ritual" });
    await writeCompletedWorkspaceState(workspaceDir);

    const files = await withEnvAsync({ OPENCLAW_HOME: parentDir }, async () =>
      resolveBootstrapFilesForRun({ workspaceDir: "~/workspace" }),
    );

    expect(files.map((file) => file.name)).toContain("AGENTS.md");
    expect(files.map((file) => file.name)).not.toContain("BOOTSTRAP.md");
  });

  it("keeps hook-added nested BOOTSTRAP.md after setup is completed", async () => {
    registerNamedBootstrapFileHook("packages/core/BOOTSTRAP.md", "BOOTSTRAP.md", "stale ritual");
    const workspaceDir = await workspace({
      "AGENTS.md": "rules",
      "BOOTSTRAP.md": "stale ritual",
      "packages/core/BOOTSTRAP.md": "package ritual",
    });
    await writeCompletedWorkspaceState(workspaceDir);

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toContain(
      path.join("packages", "core", "BOOTSTRAP.md"),
    );
    expect(files.map((file) => file.path)).not.toContain(path.join(workspaceDir, "BOOTSTRAP.md"));
  });

  it.each(["direct", "group", "channel"] as const)(
    "applies root-memory source privacy while keeping unrelated aliases for %s chats",
    async (chatType) => {
      const workspaceDir = await workspace({
        "MEMORY.md": "private memory",
        "packages/core/MEMORY.md": "nested memory",
      });
      const nestedDir = path.join(workspaceDir, "packages", "core");
      const rootAliasDir = await createDirectoryAlias(
        workspaceDir,
        workspaceDir,
        "root-memory-alias",
      );
      const nestedAliasDir = await createDirectoryAlias(
        workspaceDir,
        nestedDir,
        "nested-memory-alias",
      );
      const rootAliasPath = path.join(rootAliasDir, DEFAULT_MEMORY_FILENAME);
      const nestedAliasPath = path.join(nestedAliasDir, DEFAULT_MEMORY_FILENAME);
      registerLoadedBootstrapFilesHook([
        path.relative(workspaceDir, rootAliasPath),
        path.relative(workspaceDir, nestedAliasPath),
      ]);

      const files = await resolveBootstrapFilesForRun({
        workspaceDir,
        sessionKey: "agent:main:opaque:binding",
        chatType,
      });

      if (chatType === "direct") {
        expect(files.map((file) => file.path)).toContain(rootAliasPath);
      } else {
        expect(files.map((file) => file.path)).not.toContain(rootAliasPath);
      }
      expect(files.find((file) => file.path === nestedAliasPath)).toMatchObject({
        content: "nested memory",
        missing: false,
      });
      expect(files.findIndex((file) => file.path === nestedAliasPath)).toBeGreaterThan(
        files.findIndex((file) => file.name === "SOUL.md"),
      );
    },
  );

  it.runIf(process.platform !== "win32").each([
    { mode: "direct", chatType: "direct", sessionKey: "agent:main:opaque:binding" },
    { mode: "group", chatType: "group", sessionKey: "agent:main:opaque:binding" },
    { mode: "channel", chatType: "channel", sessionKey: "agent:main:opaque:binding" },
    { mode: "subagent", chatType: "direct", sessionKey: "agent:main:subagent:worker" },
    { mode: "cron", chatType: "direct", sessionKey: "agent:main:cron:daily:run:run-1" },
  ] as const)(
    "filters remote root-memory sources and keeps equal-byte nested memory for $mode",
    async ({ mode, chatType, sessionKey }) => {
      const workspaceDir = tempDirs.make("openclaw-bootstrap-gateway-");
      const remoteDir = await fs.realpath(tempDirs.make("openclaw-bootstrap-harness-"));
      const nestedDir = path.join(remoteDir, "nested");
      await fs.mkdir(nestedDir);
      await fs.writeFile(path.join(workspaceDir, DEFAULT_MEMORY_FILENAME), "Gateway decoy");
      for (const root of [remoteDir, nestedDir]) {
        await fs.writeFile(path.join(root, DEFAULT_MEMORY_FILENAME), "same memory bytes");
      }
      await fs.symlink(remoteDir, path.join(remoteDir, "root-alias"), "dir");
      await fs.symlink(nestedDir, path.join(remoteDir, "nested-alias"), "dir");
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandboxTestContext({
          overrides: { workspaceDir, agentWorkspaceDir: workspaceDir },
        }),
        runtime: {
          remoteWorkspaceDir: remoteDir,
          remoteAgentWorkspaceDir: remoteDir,
          runRemoteShellScript: createLocalRemoteShellScriptRunner(),
        },
      });
      const release = registerAgentWorkspaceAccess(workspaceDir, { bridge });
      try {
        registerLoadedBootstrapFilesHook(
          ["root-alias/MEMORY.md", "nested-alias/MEMORY.md"],
          mode === "subagent" ? "AGENTS.md" : mode === "cron" ? "SOUL.md" : undefined,
        );
        const files = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey, chatType });
        const paths = files.map((file) => file.path);
        const rootAliasPath = path.join(workspaceDir, "root-alias/MEMORY.md");
        if (mode === "direct") {
          expect(paths).toContain(rootAliasPath);
        } else {
          expect(paths).not.toContain(rootAliasPath);
        }
        expect(
          files.find((file) => file.path === path.join(workspaceDir, "nested-alias/MEMORY.md")),
        ).toMatchObject({ content: "same memory bytes", missing: false });
        expect(files.map((file) => file.name)).not.toContain(DEFAULT_USER_FILENAME);
        expect(files.some((file) => file.content === "Gateway decoy")).toBe(false);
      } finally {
        release();
      }
    },
  );

  it("does not let hooks relabel and re-add root MEMORY.md to shared sessions", async () => {
    registerNamedBootstrapFileHook("MEMORY.md", "SOUL.md");
    const workspaceDir = await workspace({ "MEMORY.md": "private memory" });
    const rootMemoryPath = path.join(workspaceDir, "MEMORY.md");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:slack:channel:c1",
    });

    expect(files.map((file) => file.path)).not.toContain(rootMemoryPath);
  });

  it("keeps missing hook records without source identity when policy allows them", async () => {
    const workspaceDir = await workspace({ "MEMORY.md": "private memory" });
    registerFilesHook(({ workspaceDir: rootDir }) => [
      {
        name: "SOUL.md",
        path: path.join(rootDir, "generated", "SOUL.md"),
        missing: true,
      },
    ]);

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:opaque:binding",
      chatType: "channel",
    });

    expect(files).toContainEqual({
      name: "SOUL.md",
      path: path.join(workspaceDir, "generated", "SOUL.md"),
      missing: true,
    });
  });

  it.each([
    {
      mode: "subagent",
      sessionKey: "agent:main:subagent:worker",
      relabeledName: "AGENTS.md",
      expectedNames: ["AGENTS.md"],
    },
    {
      mode: "cron",
      sessionKey: "agent:main:cron:daily:run:run-1",
      relabeledName: "SOUL.md",
      expectedNames: ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"],
    },
  ] as const)(
    "rejects loader aliases to root memory relabeled under the $mode allowlist",
    async ({ sessionKey, relabeledName, expectedNames }) => {
      const workspaceDir = await workspace({
        "AGENTS.md": "project rules",
        "SOUL.md": "persona",
        "IDENTITY.md": "identity",
        "USER.md": "user profile",
        "MEMORY.md": "memory",
        "HEARTBEAT.md": "heartbeat",
        "BOOTSTRAP.md": "setup",
      });
      const rootMemoryPath = path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);
      const aliasDir = await createDirectoryAlias(workspaceDir, workspaceDir, "root-memory-alias");
      registerLoadedBootstrapFilesHook(
        [path.relative(workspaceDir, path.join(aliasDir, DEFAULT_MEMORY_FILENAME))],
        relabeledName,
      );

      const files = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

      expect(files.map((file) => file.name)).toStrictEqual(expectedNames);
      expect(files.map((file) => file.path)).not.toContain(rootMemoryPath);
    },
  );
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("keeps bootstrap context empty in lightweight scheduled mode", async () => {
    const workspaceDir = await workspace({ "SOUL.md": "persona" });

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "cron",
    });

    expect(files).toStrictEqual([]);
  });
});

describe("resolveBootstrapContextForDiagnostics", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  function createExtraFilesConfig(hooksEnabled?: boolean): OpenClawConfig {
    return {
      hooks: {
        internal: {
          enabled: hooksEnabled,
          entries: {
            "bootstrap-extra-files": { enabled: true, paths: ["packages/*/AGENTS.md"] },
          },
        },
      },
    };
  }

  async function makeWorkspaceWithExtraAgentsFile() {
    const workspaceDir = await fs.realpath(
      await workspace({ "packages/core/AGENTS.md": "extra agents" }),
    );
    const extraPath = path.join(workspaceDir, "packages", "core", "AGENTS.md");
    return { workspaceDir, extraPath };
  }

  it("does not execute registered hooks while projecting declared files", async () => {
    const { workspaceDir, extraPath } = await makeWorkspaceWithExtraAgentsFile();
    const handler = vi.fn(() => {
      throw new Error("diagnostics must not execute hook code");
    });
    registerInternalHook("agent:bootstrap", handler);

    const result = await resolveBootstrapContextForDiagnostics({
      workspaceDir,
      config: createExtraFilesConfig(),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.contextFiles).toContainEqual({ path: extraPath, content: "extra agents" });
  });

  it("projects nothing while the hook system is disabled", async () => {
    const { workspaceDir, extraPath } = await makeWorkspaceWithExtraAgentsFile();

    const result = await resolveBootstrapContextForDiagnostics({
      workspaceDir,
      config: createExtraFilesConfig(false),
    });

    expect(result.bootstrapFiles.map((file) => file.path)).not.toContain(extraPath);
  });

  it.each([
    { label: "an import failure", handler: 'throw new Error("must not import");', projects: false },
    { label: "no readable handler", handler: undefined, projects: true },
  ])(
    "matches fresh-start selection for a managed hook with $label",
    async ({ handler, projects }) => {
      const { workspaceDir, extraPath } = await makeWorkspaceWithExtraAgentsFile();
      const managedHooksDir = await makeTempWorkspace("openclaw-managed-hooks-");
      const replacementDir = path.join(managedHooksDir, "bootstrap-extra-files");
      await fs.mkdir(replacementDir, { recursive: true });
      await fs.writeFile(
        path.join(replacementDir, "HOOK.md"),
        [
          "---",
          "name: bootstrap-extra-files",
          "description: managed replacement",
          'metadata: { "openclaw": { "events": ["agent:bootstrap"] } }',
          "---",
          "",
        ].join("\n"),
        "utf8",
      );
      if (handler !== undefined) {
        await fs.writeFile(path.join(replacementDir, "handler.js"), handler, "utf8");
      }
      const config = createExtraFilesConfig();
      config.hooks!.internal!.load = { extraDirs: [managedHooksDir] };

      const result = await resolveBootstrapContextForDiagnostics({ workspaceDir, config });

      expect(result.bootstrapFiles.some((file) => file.path === extraPath)).toBe(projects);
    },
  );
});

describe("hasCompletedBootstrapTurn", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-bootstrap-turn-");
  let tmpDir: string;
  let sessionTarget: SessionTranscriptRuntimeTarget;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = sessionDirs.make();
    sessionTarget = {
      agentId: "main",
      sessionId: randomUUID(),
      sessionKey: "agent:main:bootstrap-turn",
      storePath: path.join(tmpDir, "sessions.json"),
    };
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: sessionTarget.sessionId,
      updatedAt: Date.now(),
    });
    sessionManager = SessionManager.open(sessionTarget, tmpDir);
  });

  it("returns false without a complete SQLite transcript identity", async () => {
    expect(await hasCompletedBootstrapTurn()).toBe(false);
    expect(await hasCompletedBootstrapTurn({ ...sessionTarget, storePath: undefined })).toBe(false);
  });

  it("returns false when no full bootstrap marker has been recorded", async () => {
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sessionManager.appendCustomEntry("openclaw:unrelated", { timestamp: 2 });

    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });

  it("invalidates the old marker after compaction and accepts a newer full bootstrap marker", async () => {
    const firstEntryId = sessionManager.appendMessage(makeUserMessage("hello", 1));
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    sessionManager.appendCompaction("trimmed", firstEntryId, 10);
    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 3 });

    const hostExec = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(true);
      expect(hostExec.mock.calls.filter(([sql]) => /^BEGIN\b/iu.test(sql))).toEqual([]);
    } finally {
      hostExec.mockRestore();
    }
  });

  it("invalidates a completion marker after a session reset", async () => {
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    sessionManager.appendResetBoundary("reset");

    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });

  it("ignores completion markers on an inactive transcript branch", async () => {
    const firstEntryId = sessionManager.appendMessage(makeUserMessage("hello", 1));
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(true);

    sessionManager.appendLeafControl({
      targetId: firstEntryId,
      appendParentId: firstEntryId,
    });
    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });
});

describe("makeBootstrapWarn", () => {
  it("keeps content revisions distinct when decorating truncation warnings", () => {
    const warnings: string[] = [];
    const workspaceDir = `/tmp/${randomUUID()}`;
    for (const { sessionLabel, content } of [
      { sessionLabel: "first", content: "a" },
      { sessionLabel: "second", content: "a" },
      { sessionLabel: "first", content: "b" },
    ]) {
      buildBootstrapContextFiles(
        [
          {
            name: "AGENTS.md",
            path: `${workspaceDir}/AGENTS.md`,
            content: content.repeat(1000),
            missing: false,
          },
        ],
        {
          maxChars: 200,
          warn: makeBootstrapWarn({
            sessionLabel,
            workspaceDir,
            warn: (message) => warnings.push(message),
          }),
        },
      );
    }
    expect(warnings).toEqual([
      "workspace bootstrap file AGENTS.md is 1000 chars (limit 200); truncating in injected context (sessionKey=first)",
      "workspace bootstrap file AGENTS.md is 1000 chars (limit 200); truncating in injected context (sessionKey=first)",
    ]);
  });

  it("deduplicates repeated warnings for the same session and message", () => {
    const warnings: string[] = [];
    const warn = makeBootstrapWarn({
      sessionLabel: "agent:main:test-session",
      workspaceDir: `/tmp/${randomUUID()}`,
      warn: (message) => warnings.push(message),
    });

    warn?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");
    warn?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");

    expect(warnings).toEqual([
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:test-session)",
    ]);
  });
});

describe("resolveContextInjectionMode", () => {
  it("defaults to always when config is missing", () => {
    expect(resolveContextInjectionMode(undefined)).toBe("always");
  });

  it("uses per-agent contextInjection before defaults", () => {
    expect(
      resolveContextInjectionMode(
        {
          agents: {
            defaults: { contextInjection: "continuation-skip" },
            entries: { strict: { contextInjection: "always" } },
          },
        } as never,
        "strict",
      ),
    ).toBe("always");
  });

  it("falls back to defaults when the agent has no contextInjection override", () => {
    expect(
      resolveContextInjectionMode(
        {
          agents: {
            defaults: { contextInjection: "never" },
            entries: { worker: {} },
          },
        } as never,
        "worker",
      ),
    ).toBe("never");
  });
});
