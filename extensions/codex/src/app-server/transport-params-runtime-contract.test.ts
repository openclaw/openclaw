import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_TRANSPORT_CONFIG,
  CODEX_REASONING_EFFORT_CASES,
} from "../../../../test/helpers/agents/transport-params-runtime-contract.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { createCodexTestModel } from "./test-support.js";
import { buildTurnStartParams } from "./thread-lifecycle.js";

describe("transport params runtime contract (Codex app-server path)", () => {
  it("preserves Codex app-server transport config as the adapter transport boundary", () => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: CODEX_APP_SERVER_TRANSPORT_CONFIG,
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        requestTimeoutMs: 12_345,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "guardian_subagent",
        serviceTier: "flex",
        start: expect.objectContaining({
          transport: "websocket",
          url: "wss://codex.example.test/app-server",
          authToken: "secret-token",
          headers: {
            "x-openclaw-contract": "transport",
          },
        }),
      }),
    );
  });

  it.each(CODEX_REASONING_EFFORT_CASES)(
    "maps OpenClaw think level $thinkLevel to Codex turn effort $effort",
    ({ thinkLevel, effort }) => {
      const params = createRunAttemptParams({ thinkLevel });
      const runtime = resolveCodexAppServerRuntimeOptions();

      expect(
        buildTurnStartParams(params, {
          threadId: "thread-1",
          cwd: "/tmp/openclaw-contract",
          appServer: runtime,
        }),
      ).toEqual(
        expect.objectContaining({
          model: "gpt-5.4-codex",
          effort,
          sandboxPolicy: { type: "dangerFullAccess" },
        }),
      );
    },
  );
});

function createRunAttemptParams(params: {
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"];
}): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile: "/tmp/openclaw-contract-session.jsonl",
    workspaceDir: "/tmp/openclaw-contract",
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: params.thinkLevel,
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}
