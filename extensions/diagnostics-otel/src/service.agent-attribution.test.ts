import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { startOtelService } from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness();

test("exports the producing agent identity on run, harness, message, tool-loop, and model-call spans", async () => {
  const { service, ctx } = await startOtelService({ traces: true });
  const agent = { agentId: "ops", sessionId: "session-agent" };
  const model = {
    ...agent,
    runId: "run-agent-1",
    provider: "anthropic",
    model: "claude-opus-4-7",
  };

  emitTrustedDiagnosticEvent({
    type: "run.completed",
    ...model,
    durationMs: 100,
    outcome: "completed",
  });
  emitTrustedDiagnosticEvent({
    type: "harness.run.completed",
    ...model,
    harnessId: "claude-cli",
    durationMs: 100,
    outcome: "completed",
  });
  emitTrustedDiagnosticEvent({
    type: "message.processed",
    ...agent,
    channel: "webchat",
    durationMs: 5,
    outcome: "completed",
  });
  emitTrustedDiagnosticEvent({
    type: "tool.loop",
    ...agent,
    toolName: "read",
    level: "warning",
    action: "warn",
    detector: "generic_repeat",
    count: 3,
    message: "repeated read calls",
  });
  emitTrustedDiagnosticEvent({
    type: "model.call.completed",
    ...model,
    callId: "call-agent-1",
    api: "claude-code",
    transport: "stdio-live",
    observationUnit: "turn",
    durationMs: 80,
  });
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const spanAgent = (name: string) =>
    sdk.exporter
      .getFinishedSpans()
      .filter((span) => span.name === name)
      .map((span) => span.attributes["openclaw.agent"]);
  expect(spanAgent("openclaw.run")).toEqual(["ops"]);
  expect(spanAgent("openclaw.harness.run")).toEqual(["ops"]);
  expect(spanAgent("openclaw.message.processed")).toEqual(["ops"]);
  expect(spanAgent("openclaw.tool.loop")).toEqual(["ops"]);
  expect(spanAgent("openclaw.model.call")).toEqual(["ops"]);
});
