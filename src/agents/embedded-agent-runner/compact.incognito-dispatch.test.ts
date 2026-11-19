import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createAgentSessionMock,
  enqueueCommandInLaneMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveContextEngineMock,
  sessionCompactImpl,
} from "./compact.hooks.harness.js";

let compactQueued: Awaited<
  ReturnType<typeof loadCompactHooksHarness>
>["compactEmbeddedAgentSession"];
let compactDirect: Awaited<
  ReturnType<typeof loadCompactHooksHarness>
>["compactEmbeddedAgentSessionDirect"];
let actorStorage: typeof import("../../config/sessions/session-actor-storage-acquisition.js");
let actorBinding: typeof import("../../config/sessions/session-actor-storage-binding.js");
let actorOwners: typeof import("../../config/sessions/session-actor-memory-owner.js");
let sessions: typeof import("../sessions/session-manager.js");
let gateway: typeof import("../../gateway/server-methods/sessions-compaction-runner.js");
let worker: typeof import("../../config/sessions/session-compaction-prepared.js");
let paths: typeof import("../../state/openclaw-agent-db.paths.js");
let selected:
  | import("../../config/sessions/session-actor-storage-binding.js").SelectedSessionActorStorageBinding
  | undefined;
const authority = { assertCurrent() {}, authorize() {} };
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    if (selected) {
      await selected.actor.release();
      actorOwners.memorySessionActorOwners.closeDatabase(selected);
      selected = undefined;
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
let workspaceDir: string;

beforeAll(async () => {
  ({
    compactEmbeddedAgentSession: compactQueued,
    compactEmbeddedAgentSessionDirect: compactDirect,
  } = await loadCompactHooksHarness());
  [actorStorage, actorBinding, actorOwners, sessions, gateway, worker, paths] = await Promise.all([
    import("../../config/sessions/session-actor-storage-acquisition.js"),
    import("../../config/sessions/session-actor-storage-binding.js"),
    import("../../config/sessions/session-actor-memory-owner.js"),
    import("../sessions/session-manager.js"),
    import("../../gateway/server-methods/sessions-compaction-runner.js"),
    import("../../config/sessions/session-compaction-prepared.js"),
    import("../../state/openclaw-agent-db.paths.js"),
  ]);
});

beforeEach(async () => {
  workspaceDir = tempDirs.make("openclaw-incognito-compaction-");
  vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
  resetCompactHooksHarnessMocks(workspaceDir, "incognito-compaction");
  const queue = await vi.importActual<typeof import("../../process/command-queue.js")>(
    "../../process/command-queue.js",
  );
  enqueueCommandInLaneMock.mockImplementation(queue.enqueueCommandInLane);
  // Select the built-in direct runtime, not a mocked context-engine completion.
  const { delegateCompactionToRuntime } = await import("../../context-engine/delegate.js");
  resolveContextEngineMock.mockResolvedValue({
    info: { id: "legacy", ownsCompaction: false },
    compact: delegateCompactionToRuntime,
  });
});

it.each(["prepared", "queued", "direct"] as const)(
  "compacts %s incognito actors without a SQLite compaction worker",
  async (route) => {
    const env = { OPENCLAW_STATE_DIR: workspaceDir };
    const target = {
      agentId: "main",
      sessionId: "incognito-compaction",
      sessionKey: "agent:main:dashboard:incognito-compaction",
      storePath: paths.resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      env,
    };
    selected = await actorStorage.acquireSessionActorStorage(target, {
      authority,
      lifetime: { assertCurrent() {}, assertReadable() {} },
      create: true,
    });
    if (!selected) {
      throw new Error("Expected an incognito actor");
    }
    const binding = selected;
    const entry = { sessionId: target.sessionId, lifecycleRevision: "initial", updatedAt: 1 };
    await binding.actor.storage.mutate(
      { type: "session.entry.create", input: { entry, cwd: workspaceDir } },
      authority,
    );
    await actorBinding.runWithSessionActorStorage(binding, async () => {
      const manager = await sessions.SessionManager.openAsync(target, workspaceDir);
      await manager.appendMessageAsync({
        role: "user",
        content: "Review the deployment plan.",
        timestamp: 1,
      });
      await manager.appendMessageAsync({
        role: "assistant",
        content: [{ type: "text", text: "The plan is ready for review." }],
        api: "openai-completions",
        provider: "openai",
        model: "fake",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      await manager.appendMessageAsync({
        role: "user",
        content: "Keep the deployment decision in the summary.",
        timestamp: 3,
      });
      const sqliteCompaction = vi.spyOn(worker, "readPreparedSessionCompactionInWorker");
      const cfg = {
        agents: {
          defaults: { workspace: workspaceDir, model: { primary: "incognito-proof/fake" } },
        },
      };
      const prepared =
        route === "prepared"
          ? await gateway.prepareGatewaySessionCompaction({
              ...target,
              cfg,
              entry,
              sessionStoreKey: target.sessionKey,
            })
          : undefined;
      if (prepared) {
        expect(prepared.reason).toBeUndefined();
        expect(prepared.preparedSession?.sessionManager).toBeDefined();
      }
      const params = {
        ...target,
        sessionTarget: target,
        sessionFile: target.sessionKey,
        workspaceDir,
        config: cfg,
        provider: "incognito-proof",
        model: "fake",
        trigger: "manual",
      } satisfies Parameters<typeof compactDirect>[0];
      const result =
        route === "direct"
          ? await compactDirect(params)
          : await compactQueued(
              params,
              prepared ? { preparedSession: prepared.preparedSession } : {},
            );
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        compacted: true,
        result: { summary: "summary" },
      });
      expect(createAgentSessionMock).toHaveBeenCalledOnce();
      expect(sessionCompactImpl).toHaveBeenCalledOnce();
      expect(sqliteCompaction).not.toHaveBeenCalled();
    });
  },
);
