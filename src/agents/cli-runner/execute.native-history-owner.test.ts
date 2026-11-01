import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliExecutionHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import type { CliBackendExecuteContext } from "../../plugins/cli-backend.types.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

afterEach(() => {
  supervisorSpawnMock.mockReset();
  vi.unstubAllEnvs();
});

function nativeRun(replaysHistory = false, history = false) {
  const calls: string[] = [];
  const writer: CliExecutionHistoryWriter = {
    target: { agentId: "main", sessionId: "s1", sessionKey: "agent:main:s1", storePath: "x" },
    runId: "run-test",
    authFingerprint: "f".repeat(64),
    bindsNativeLogin: true,
    replaysHistory,
    assertCurrent: () => {},
    assertReadable: async () => {},
    confirmsOwner: () => false,
    checkNativeLoginBoundary: () => {},
    // As the real writer does on a drifted login: refuse a turn carrying saved history,
    // and let any other turn run without coverage.
    bindExecutionEnv: vi.fn((_env: NodeJS.ProcessEnv, carriesSavedHistory: boolean) => {
      calls.push("bindExecutionEnv");
      if (carriesSavedHistory) {
        throw new Error("CLI history authority changed before execution");
      }
    }),
    settleNativeLogin: vi.fn(async () => void calls.push("settleNativeLogin")),
  };
  const context = buildPreparedCliRunContext({
    model: "fixture-model",
    backend: {
      command: "/bin/sh",
      args: [],
      output: "text",
      systemPromptFileArg: undefined,
      input: "stdin",
      env: { CLAUDE_CONFIG_DIR: "/fixture/backend-selected" },
    },
  });
  context.cliHistoryWriter = writer;
  if (history) {
    context.openClawHistoryPrompt = "saved history";
  }
  supervisorSpawnMock.mockImplementation(async () => {
    calls.push("spawn");
    return createManagedRun({ ...createSuccessfulProcessExit(), durationMs: 1, stdout: "done" });
  });
  return { writer, calls, context };
}

describe("native login history owner at execution", () => {
  it.each([
    { provider: "claude-cli", plugin: false },
    { provider: "google-gemini-cli", plugin: false },
    { provider: "claude-cli", plugin: true },
  ] as const)(
    "keeps $provider catch-up private and out of fresh, foreign, and forked attempts (plugin=$plugin)",
    async ({ provider, plugin }) => {
      const prompts: string[] = [];
      const privateContexts: Array<CliBackendExecuteContext["promptContext"]> = [];
      const context = buildPreparedCliRunContext({
        provider,
        prompt: "CURRENT_REQUEST",
        workspaceDir: process.cwd(),
        backend: {
          command: "/bin/sh",
          args: [],
          resumeArgs: ["--resume", "{sessionId}"],
          forkArg: "--fork-session",
          input: "stdin",
          output: "json",
          systemPromptFileArg: undefined,
          sessionIdFields: ["session_id"],
        },
      });
      context.resumeContext = "SAME_CONVERSATION_HANDOFF";
      context.openClawHistoryPrompt = "FRESH_REQUEST";
      context.reusableCliSession = { mode: "reuse", sessionId: "bound-native" };
      if (plugin) {
        context.promptContext = {
          prependContext: "PRIVATE_CONTEXT",
          appendContext: "PRIVATE_TAIL",
        };
        context.executionTarget = {
          kind: "plugin",
          async *execute(input) {
            prompts.push(input.prompt);
            privateContexts.push(input.promptContext);
            yield {
              type: "result",
              subtype: "success",
              result: "done",
              session_id: "native-result",
            };
          },
        };
      }
      supervisorSpawnMock.mockImplementation(async (spawn) => {
        if (spawn.mode !== "child") {
          throw new Error("Expected CLI child process");
        }
        prompts.push(spawn.input ?? "");
        return createManagedRun({
          ...createSuccessfulProcessExit(),
          stdout: JSON.stringify({
            result: "done",
            session_id: "native-result",
          }),
        });
      });
      await executePreparedCliRun(context, "bound-native");
      await executePreparedCliRun(context);
      await executePreparedCliRun(context, "foreign-native");
      context.params.forkCliSessionOnResume = true;
      context.params.claimCliSessionFork = async () => true;
      context.params.persistCliSessionForkSuccessor = async () => {};
      await executePreparedCliRun(context, "bound-native");
      expect(prompts).toEqual([
        plugin ? "CURRENT_REQUEST" : "SAME_CONVERSATION_HANDOFF\n\nCURRENT_REQUEST",
        "FRESH_REQUEST",
        "CURRENT_REQUEST",
        "CURRENT_REQUEST",
      ]);
      if (plugin) {
        expect(privateContexts).toEqual([
          {
            prependContext: "PRIVATE_CONTEXT\n\nSAME_CONVERSATION_HANDOFF",
            appendContext: "PRIVATE_TAIL",
          },
          ...Array.from({ length: 3 }, () => ({
            prependContext: "PRIVATE_CONTEXT",
            appendContext: "PRIVATE_TAIL",
          })),
        ]);
      }
    },
  );

  it.each(["ambient", "configured", "prepared", "mixed-case"])(
    "removes %s host credentials before binding native-only history and spawning",
    async (source) => {
      const key = source === "mixed-case" ? "Openai_Api_Key" : "OPENAI_API_KEY";
      const credentials = {
        [key]: "synthetic-host-key",
        CUSTOM_CLI_CREDENTIAL: "synthetic-custom",
        Claude_Code_Oauth_Token: "synthetic-token",
        Claude_Code_Provider_Managed_By_Host: "synthetic-marker",
        CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "3",
      };
      vi.stubEnv("OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV", "OPENAI_API_KEY CUSTOM_CLI_CREDENTIAL");
      if (source === "ambient") {
        for (const [name, value] of Object.entries(credentials)) {
          vi.stubEnv(name, value);
        }
      }
      const { writer, calls, context } = nativeRun();
      context.params.nativeAuthOnly = true;
      context.preparedBackend.backend.clearEnv = [
        "CUSTOM_CLI_CREDENTIAL",
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
        "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
        "MAX_THINKING_TOKENS",
      ];
      if (source === "configured" || source === "mixed-case") {
        Object.assign(context.preparedBackend.backend.env!, credentials);
      }
      context.preparedBackend.env = {
        ...(source === "prepared" || source === "mixed-case" ? credentials : {}),
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
        MAX_THINKING_TOKENS: "16384",
      };
      context.preparedBackend.secretInput = {
        fd: 3,
        fingerprint: "synthetic-credential-fingerprint",
        createData: () => Buffer.from("synthetic-descriptor-credential"),
      };

      await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "done" });
      const spawned = supervisorSpawnMock.mock.lastCall?.[0];
      const [historyEnv] = vi.mocked(writer.bindExecutionEnv).mock.calls[0] ?? [];
      for (const env of [spawned?.env, historyEnv]) {
        for (const name of Object.keys(credentials)) {
          expect(env?.[name] === undefined).toBe(true);
        }
        expect(env).toMatchObject({
          CLAUDE_CONFIG_DIR: "/fixture/backend-selected",
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
          CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
          MAX_THINKING_TOKENS: "16384",
        });
      }
      expect(spawned?.mode === "child" && spawned.secretInput === undefined).toBe(true);
      expect(calls).toEqual(["bindExecutionEnv", "spawn", "settleNativeLogin"]);
    },
  );

  it.each([undefined, "resumed-session"])(
    "spawns nothing when saved history selects another login (resume=%s)",
    async (resumeSession) => {
      const { calls, context } = nativeRun(true, resumeSession === undefined);
      await expect(executePreparedCliRun(context, resumeSession)).rejects.toThrow(
        "CLI history authority changed",
      );
      expect(calls).not.toContain("spawn");
    },
  );

  it("settles the native login even when the run fails", async () => {
    const { calls, context } = nativeRun();
    supervisorSpawnMock.mockImplementation(async () => {
      calls.push("spawn");
      throw new Error("child failed");
    });
    await expect(executePreparedCliRun(context)).rejects.toThrow();
    expect(calls.slice(-2)).toEqual(["spawn", "settleNativeLogin"]);
  });
});
