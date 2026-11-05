import { PassThrough, Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runNativeHookRelayCliFromArgvForTest } from "../../cli/native-hook-relay-cli.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { splitShellArgs } from "../../utils/shell-argv.js";
import {
  invokeNativeHookRelay,
  registerOwnedNativeHookRelay,
  testing,
} from "./native-hook-relay.js";

afterEach(async () => {
  await testing.clearNativeHookRelaysForTests();
  vi.restoreAllMocks();
});

it("denies a retired run's hook when its successor reuses the native thread credential", async () => {
  await withOpenClawTestState({ label: "native-hook-run-ownership" }, async () => {
    const first = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: "codex-shared-native-thread",
      generation: "persisted-native-thread-generation",
      sessionId: "session-1",
      runId: "run-1",
      requireForegroundTurn: true,
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: async () => ({
        blocked: true,
        kind: "veto",
        reason: "First run denies this tool",
      }),
    });
    await first.ready;
    first.bindForegroundTurn("native-thread-1", "retired-turn-1");
    const command = splitShellArgs(first.commandForEvent("pre_tool_use"));
    if (!command) {
      throw new Error("Generated hook command must parse");
    }
    const successorPolicy = vi.fn(async () => ({
      blocked: false as const,
      params: { command: "echo synthetic" },
    }));
    const successor = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: first.relayId,
      generation: first.generation,
      sessionId: first.sessionId,
      runId: "run-2",
      requireForegroundTurn: true,
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: successorPolicy,
    });
    await successor.ready;
    successor.bindForegroundTurn("native-thread-1", "current-turn-2");
    first.unregister();
    const stdout = new PassThrough();
    const callGateway = vi.fn(async () => {
      throw new Error("Unexpected Gateway fallback");
    });
    await expect(
      runNativeHookRelayCliFromArgvForTest(command, {
        stdin: Readable.from([
          JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: "native-thread-1",
            turn_id: "retired-turn-1",
            tool_name: "Bash",
            tool_use_id: "late-call-1",
            tool_input: { command: "echo synthetic" },
          }),
        ]),
        stdout,
        stderr: new PassThrough(),
        callGateway,
      }),
    ).resolves.toBe(0);
    expect(String(stdout.read() ?? "")).toContain('"permissionDecision":"deny"');
    expect(successorPolicy).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
    expect(testing.getNativeHookRelayInvocationsForTests()).toEqual([]);
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: successor.relayId,
        generation: successor.generation,
        requireGeneration: true,
        event: "pre_tool_use",
        rawPayload: {
          session_id: "native-thread-1",
          turn_id: "current-turn-2",
          tool_name: "Bash",
          tool_input: { command: "echo synthetic" },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(successorPolicy).toHaveBeenCalledOnce();
    successor.unregister();
    await Promise.all([first.drain(), successor.drain()]);
    expect(testing.getNativeHookRelayRegistrationForTests(successor.relayId)).toBeUndefined();
    expect(await testing.getNativeHookRelayBridgeRecordForTests(successor.relayId)).toBeUndefined();
  });
});
