import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, expect, it } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { CodexNativeToolLifecycleProjector } from "./event-projector-native-tool-lifecycle.js";
import { emitCodexNativePreToolUseFailureDiagnostic } from "./native-hook-relay.js";
import type { JsonObject } from "./protocol.js";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) {
    close();
  }
});
async function host() {
  const value = await createAgentHarnessHostCapabilitiesForTest({
    pluginId: "codex",
    attempt: { runId: "native-report", agentId: "main", sessionId: "native-session" },
  });
  closers.push(value.close);
  return value;
}
it("settles a native item through its admitted handle after host closure", async () => {
  const h = await host();
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event) => events.push(event));
  try {
    const projector = new CodexNativeToolLifecycleProjector(
      { hostCapabilities: h.capabilities },
      "thread",
      "turn",
    );
    const item = {
      type: "commandExecution" as const,
      id: "native-command",
      command: "true",
      cwd: "/fixture",
      status: "inProgress",
      processId: null,
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    const notify = (method: string, nativeItem: JsonObject) =>
      projector.handleNotification({
        method,
        params: { threadId: "thread", turnId: "turn", item: nativeItem },
      });
    notify("item/started", item);
    h.close();
    notify("item/completed", { ...item, status: "completed", exitCode: 0, durationMs: 2 });
    expect(() => notify("item/started", { ...item, id: "new" })).toThrow();
    await waitForDiagnosticEventsDrained();
    expect(
      events.filter((event) => event.type.startsWith("tool.execution.")).map((event) => event.type),
    ).toEqual(["tool.execution.started", "tool.execution.completed"]);
  } finally {
    stop();
  }
});
it("retains an item-less pre-tool failure handle accepted before cancellation", async () => {
  const h = await host();
  const report = h.capabilities.bindToolExecution!({ toolName: "exec", toolCallId: "pre-tool" });
  h.close();
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event) => events.push(event));
  try {
    emitCodexNativePreToolUseFailureDiagnostic({
      failure: {
        toolName: "forged",
        toolCallId: "forged",
        disposition: "cancelled",
        durationMs: 1,
        report,
      },
    });
    await waitForDiagnosticEventsDrained();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.execution.error",
        toolName: "exec",
        toolCallId: "pre-tool",
        runId: "native-report",
        toolOwner: "codex",
      }),
    );
  } finally {
    stop();
  }
});
it("reports quarantine through the host identity and rejects a missing capability", async () => {
  const h = await host();
  const params = {
    tools: [
      {
        name: "broken",
        label: "Broken",
        description: "Invalid schema fixture",
        parameters: { type: "array" },
        execute: async () => {
          throw new Error("must never execute");
        },
      },
    ],
    signal: new AbortController().signal,
    hookContext: { runId: "forged-run" },
  };
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event) => events.push(event));
  try {
    expect(() => createCodexDynamicToolBridge(params)).toThrow("requires host execution reporting");
    const bridge = createCodexDynamicToolBridge({
      ...params,
      bindToolExecution: h.capabilities.bindToolExecution,
    });
    expect(bridge.availableTools).toEqual([]);
    await waitForDiagnosticEventsDrained();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.execution.blocked",
        runId: "native-report",
        toolName: "broken",
        toolOwner: "codex",
      }),
    );
    expect(JSON.stringify(events)).not.toContain("forged-run");
  } finally {
    stop();
  }
});
