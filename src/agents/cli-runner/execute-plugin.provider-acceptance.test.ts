import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePluginOwnedProcess } from "./execute-plugin.js";

const admissions: Array<ReturnType<typeof prepareSystemAgentRunAdmission>> = [];

afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  vi.restoreAllMocks();
});

describe("plugin-owned provider acceptance", () => {
  it("projects the adapter receipt through the host execution phase", async () => {
    const runId = "plugin-provider-acceptance";
    const config = { tools: { exec: { security: "full" as const, ask: "off" as const } } };
    const admission = prepareSystemAgentRunAdmission(config, runId, "main", "plugin-test");
    admissions.push(admission);
    const context = buildPreparedCliRunContext({
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      agentId: "main",
      runId,
      sessionId: "sdk-session",
      sessionKey: "agent:main:main",
      prompt: "hello",
      config,
      executionMode: "agent",
      timeoutMs: 5_000,
      systemPrompt: "Follow host policy.",
      backend: { command: "/bin/sh", args: [] },
    });
    context.params.admittedRunContext = await admission.admit("plugin-harness");
    const onExecutionPhase = vi.fn();
    context.params.onExecutionPhase = onExecutionPhase;

    await executePluginOwnedProcess({
      context,
      async *execute(execution) {
        execution.onProviderAccepted?.();
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "completed",
          session_id: "sdk-session",
        };
      },
      executionCommand: "/bin/sh",
      executionArgs: ["-p"],
      env: { PATH: "/bin:/usr/bin" },
      prompt: context.params.prompt,
      useResume: false,
      sessionId: "sdk-session",
      noOutputTimeoutMs: 2_000,
      consumeStdout: () => {},
    });

    expect(onExecutionPhase).toHaveBeenCalledExactlyOnceWith({
      phase: "turn_accepted",
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      backend: "claude-cli",
    });
  });
});
