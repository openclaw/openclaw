import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { runSessionFork } from "./session-fork-run.js";
import { withSessionState } from "./sessions/session-manager-fixtures.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const runEmbeddedAgent = vi.hoisted(() =>
  vi.fn<typeof import("./embedded-agent.js").runEmbeddedAgent>(),
);
const runCliAgent = vi.hoisted(() => vi.fn<typeof import("./cli-runner.runtime.js").runCliAgent>());
// mock-isolation: run the real fork preparation without a provider request or CLI process.
vi.mock("./embedded-agent.js", () => ({ runEmbeddedAgent }));
// mock-isolation: observe the CLI fork request without starting a CLI process.
vi.mock("./cli-runner.runtime.js", () => ({ runCliAgent }));

const CLI_MODEL = { provider: "anthropic", model: "claude-opus-4-7" };
const cliConfig: OpenClawConfig = {
  agents: {
    defaults: { models: { "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } } } },
  },
};

beforeEach(() => {
  runEmbeddedAgent.mockResolvedValue({ meta: { durationMs: 1 } });
  runCliAgent.mockResolvedValue({ meta: { durationMs: 1 }, payloads: [{ text: "native answer" }] });
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        pluginId: "anthropic",
        modelProvider: "anthropic",
        config: {
          command: "claude",
          resumeArgs: ["--resume", "{sessionId}"],
          forkArg: "--fork-session",
          resumeAtArg: "--resume-session-at",
        },
      },
    ],
  });
});
afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.clearAllMocks();
});

/** A claude-cli session whose last reply ran in native session `native-1` at `reply-uuid`. */
async function withCliSession(
  run: (fixture: {
    anchor: NonNullable<
      Awaited<ReturnType<SessionManager["appendMessageWithTranscriptAnchorAsync"]>>["anchor"]
    >;
    workspaceDir: string;
    transcript: () => unknown[];
  }) => Promise<void>,
  options: { nativeReply?: boolean; bindingSessionId?: string; spawnedCwd?: string } = {},
) {
  await withSessionState("cli-fork", async ({ scope, state }) => {
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 2,
      cliSessionBindings: {
        "claude-cli": { sessionId: options.bindingSessionId ?? "native-1" },
      },
      ...(options.spawnedCwd ? { spawnedCwd: options.spawnedCwd } : {}),
    });
    const source = SessionManager.open(scope);
    await source.appendMessageAsync({ role: "user", content: "Rewrite my prompt", timestamp: 1 });
    const reply = makeAgentAssistantMessage({
      content: [{ type: "text", text: "Done." }],
      provider: "claude-cli",
      model: "claude-opus-4-7",
    });
    const { anchor } = await source.appendMessageWithTranscriptAnchorAsync(
      options.nativeReply === false
        ? reply
        : Object.assign(reply, {
            __openclaw: {
              importedFrom: "claude-cli",
              cliSessionId: "native-1",
              externalId: "reply-uuid",
            },
          }),
    );
    if (!anchor) {
      throw new Error("missing anchor");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
    await run({
      anchor,
      workspaceDir: state.workspaceDir,
      transcript: () =>
        database.db
          .prepare(
            "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
          )
          .all(scope.sessionId),
    });
  });
}

const fork = (
  source: Parameters<typeof runSessionFork>[0]["source"],
  workspaceDir: string,
  overrides: Partial<Parameters<typeof runSessionFork>[0]> = {},
) =>
  runSessionFork(
    {
      config: cliConfig,
      source,
      prompt: "Improve the next prompt",
      tools: ["read", "ls", "exec"],
      runId: "cli-fork-run",
      owner: "plugin:better-prompt",
      model: CLI_MODEL,
      workspaceDir,
      timeoutMs: 1_000,
      ...overrides,
    },
    async (outcome) => outcome,
  );

it.each([
  // The anchored CLI turn records its runtime as the provider.
  {
    name: "the turn's CLI runtime ref",
    model: { provider: "claude-cli", model: "claude-opus-4-7" },
  },
  { name: "a model configured to run on the CLI", model: CLI_MODEL },
])("forks the native session at the anchored reply for $name", async ({ model }) => {
  await withCliSession(async ({ anchor, workspaceDir, transcript }) => {
    const before = transcript();
    const outcome = await fork(anchor, workspaceDir, {
      model,
      requester: { senderIsOwner: true },
    });

    expect(outcome).toMatchObject({ ok: true, result: { payloads: [{ text: "native answer" }] } });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runCliAgent.mock.calls[0]?.[0]).toMatchObject({
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-opus-4-7",
      controlOperation: "fork",
      cliSessionId: "native-1",
      forkCliSessionOnResume: true,
      cliSessionResumeAt: "reply-uuid",
      toolCallsAllow: ["read", "ls", "exec"],
      runtimePolicySessionKey: anchor.sessionKey,
      disableCliLiveSession: true,
      inputProvenance: {
        kind: "internal_system",
        sourceTool: "session_fork",
        sourceSessionKey: anchor.sessionKey,
      },
    });
    // The fork runs under its own internal identity and never writes the source transcript.
    expect(runCliAgent.mock.calls[0]?.[0].sessionKey).not.toBe(anchor.sessionKey);
    expect(transcript()).toEqual(before);
  });
});

it.each([
  {
    name: "the agent's run cwd",
    config: { cwd: "/work/agent-cwd" },
    spawnedCwd: undefined,
    cwd: "/work/agent-cwd",
  },
  {
    name: "the session's spawned cwd",
    config: { cwd: "/work/agent-cwd" },
    spawnedCwd: "/work/spawned",
    cwd: "/work/spawned",
  },
])("runs a CLI fork in $name, where its turns ran the CLI", async (row) => {
  await withCliSession(
    async ({ anchor, workspaceDir }) => {
      await fork(anchor, workspaceDir, {
        config: {
          agents: { defaults: { ...cliConfig.agents?.defaults, ...row.config } },
        },
      });
      expect(runCliAgent.mock.calls[0]?.[0].cwd).toBe(row.cwd);
    },
    { spawnedCwd: row.spawnedCwd },
  );
});

it("keeps exec out of a CLI fork of a turn the owner did not send", async () => {
  await withCliSession(async ({ anchor, workspaceDir }) => {
    await fork(anchor, workspaceDir);
    expect(runCliAgent.mock.calls[0]?.[0].toolCallsAllow).toEqual(["read", "ls"]);
  });
});

it.each([
  {
    name: "a reply the CLI session did not record",
    options: { nativeReply: false },
    error: "branch at a claude-cli reply recorded in the transcript; the anchored turn has none",
  },
  {
    name: "a reply from an earlier native session",
    options: { bindingSessionId: "native-2" },
    error: "belongs to an earlier one",
  },
])("refuses a CLI fork through $name before any CLI or provider I/O", async (row) => {
  await withCliSession(async ({ anchor, workspaceDir }) => {
    const outcome = await fork(anchor, workspaceDir);
    expect(outcome).toMatchObject({ ok: false, cancelled: false });
    expect(String((outcome as { error?: unknown }).error)).toContain(row.error);
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  }, row.options);
});

it("keeps plugin-tool forks and built-in sessions on the built-in runtime", async () => {
  await withCliSession(async ({ anchor, workspaceDir }) => {
    await fork(anchor, workspaceDir, {
      tools: ["skill_workshop"],
      runtimePluginToolGrant: { pluginId: "skill-workshop", toolNames: ["skill_workshop"] },
    });
    await fork(anchor, workspaceDir, {
      config: {},
      model: { provider: "openai", model: "gpt-test" },
    });
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
    });
  });
});
