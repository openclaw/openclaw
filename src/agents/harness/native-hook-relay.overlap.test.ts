import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNativeHookRelayCliFromArgv } from "../../cli/native-hook-relay-cli.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { splitShellArgs } from "../../utils/shell-argv.js";
import { invokeNativeHookRelayBridge } from "./native-hook-relay-client.js";
import {
  deleteNativeHookRelayBridgeRecordIfOwned,
  readNativeHookRelayBridgeRecord,
} from "./native-hook-relay-store.js";
import { registerOwnedNativeHookRelay, testing } from "./native-hook-relay.js";

const execFileAsync = promisify(execFile);

function registerAgentRelay(
  overrides: Partial<Parameters<typeof registerOwnedNativeHookRelay>[0]> = {},
) {
  return registerOwnedNativeHookRelay({
    provider: "codex",
    relayId: `overlap-${randomUUID()}`,
    sessionId: "session-1",
    runId: "run-1",
    agentId: "agent-1",
    sessionKey: "agent:main:session-1",
    ...overrides,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await testing.clearNativeHookRelaysForTests();
});

describe("native hook relay overlapping owners", () => {
  it("preserves unclaimed turn routing for a sole legacy owner", async () => {
    const relay = registerAgentRelay({ allowedEvents: ["post_tool_use"] });
    await relay.ready;

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: relay.relayId,
        generation: relay.generation,
        event: "post_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PostToolUse",
          turn_id: "legacy-unclaimed-turn",
          tool_name: "Bash",
          tool_use_id: "legacy-call",
          tool_input: { command: "/bin/echo ok" },
          tool_response: { output: "ok", exit_code: 0 },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    relay.unregister();
  });

  it("keeps an unclaimed turn fail-closed while legacy owners overlap", async () => {
    const relayId = `overlap-unclaimed-${randomUUID()}`;
    const first = registerAgentRelay({ relayId, allowedEvents: ["post_tool_use"] });
    const second = registerAgentRelay({ relayId, allowedEvents: ["post_tool_use"] });
    await Promise.all([first.ready, second.ready]);

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId,
        generation: second.generation,
        event: "post_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PostToolUse",
          turn_id: "contested-unclaimed-turn",
          tool_name: "Bash",
          tool_use_id: "contested-unclaimed-call",
          tool_input: { command: "/bin/echo ok" },
          tool_response: { output: "ok", exit_code: 0 },
        },
      }),
    ).rejects.toThrow("native hook relay bridge stale registration");

    second.unregister();
    first.unregister();
  });

  it("proves overlap recovery and rejects released ownership before final effect", async () => {
    const relayId = `overlap-final-effect-${randomUUID()}`;
    const generation = "shared-generation";
    const finalEffects: Array<{ turnId: string; stdout: string }> = [];
    const trace: Array<Record<string, unknown>> = [];
    const first = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId,
      generation,
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });
    const second = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId,
      generation,
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["pre_tool_use"],
    });
    await Promise.all([first.ready, second.ready]);
    expect(first.claimTurn?.("turn-1")).toBe(true);
    expect(second.claimTurn?.("turn-1")).toBe(false);
    trace.push({ stage: "overlap", turn1: "claimed-run-1", survivor: "unclaimed-run-2" });

    const before = await readNativeHookRelayBridgeRecord({ relayId });
    if (!before) {
      throw new Error("native hook relay bridge record missing before recovery proof");
    }
    expect(
      await deleteNativeHookRelayBridgeRecordIfOwned({
        relayId,
        pid: before.pid,
        token: before.token,
      }),
    ).toBe(true);
    first.renew(60_000);
    await first.drain();
    expect(await readNativeHookRelayBridgeRecord({ relayId })).toBeDefined();
    await first.verifyPreToolUse?.("turn-1");
    trace.push({ stage: "recovery", result: "direct-pre-tool-use-serviced" });

    const commandArgv = splitShellArgs(first.commandForEvent("pre_tool_use", { timeoutMs: 2_000 }));
    if (!commandArgv) {
      throw new Error("generated Codex hook command did not parse");
    }
    const callGateway = vi.fn(async (): Promise<never> => {
      throw new Error("stale ownership must not escape through the Gateway fallback");
    });
    const attemptFinalEffect = async (turnId: string, toolUseId: string) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const exitCode = await runNativeHookRelayCliFromArgv(commandArgv, {
        stdin: Readable.from([
          JSON.stringify({
            hook_event_name: "PreToolUse",
            turn_id: turnId,
            tool_name: "Bash",
            tool_use_id: toolUseId,
            tool_input: { command: "/bin/echo ok" },
          }),
        ]),
        stdout,
        stderr,
        callGateway,
      });
      const hookStdout = String(stdout.read() ?? "");
      const hookStderr = String(stderr.read() ?? "");
      const denied = hookStdout.includes('"permissionDecision":"deny"');
      let executed = false;
      if (exitCode === 0 && !hookStderr && !denied) {
        const finalIo = await execFileAsync("/bin/echo", ["ok"]);
        finalEffects.push({ turnId, stdout: finalIo.stdout.trim() });
        executed = true;
      }
      return {
        exitCode,
        stdout: hookStdout,
        stderr: hookStderr,
        executed,
      };
    };

    const firstResponse = await attemptFinalEffect("turn-1", "allowed-call-1");
    expect(firstResponse).toMatchObject({ exitCode: 0, stdout: "", stderr: "", executed: true });
    trace.push({
      stage: "live-owners",
      responses: [firstResponse],
      finalEffects: [...finalEffects],
    });

    first.unregister();
    expect(second.claimTurn("turn-1")).toBe(false);
    const releasedResponse = await attemptFinalEffect("turn-1", "released-call-1");
    expect(releasedResponse).toMatchObject({ exitCode: 0, executed: false });
    expect(releasedResponse.stderr).toContain("native hook relay bridge stale registration");
    expect(JSON.parse(releasedResponse.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
    expect(callGateway).not.toHaveBeenCalled();
    expect(finalEffects).toEqual([{ turnId: "turn-1", stdout: "ok" }]);
    trace.push({
      stage: "released-owner",
      result: "rejected-before-final-effect",
      response: releasedResponse,
      finalEffects: [...finalEffects],
    });

    expect(second.claimTurn?.("turn-2")).toBe(true);
    await attemptFinalEffect("turn-2", "allowed-call-2-after-release");
    expect(finalEffects).toEqual([
      { turnId: "turn-1", stdout: "ok" },
      { turnId: "turn-2", stdout: "ok" },
    ]);
    trace.push({ stage: "surviving-owner", finalEffects: [...finalEffects] });
    process.stdout.write(`native-hook-relay-behavior-proof ${JSON.stringify(trace)}\n`);
    second.unregister();
  });

  it("routes overlapping same-generation turns to their exact run owners", async () => {
    const relayId = `overlapping-turn-owners-${randomUUID()}`;
    const first = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId,
      generation: "shared-generation",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    const second = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId,
      generation: "shared-generation",
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });
    await Promise.all([first.ready, second.ready]);
    first.claimTurn?.("turn-1");
    second.claimTurn?.("turn-2");

    for (const [turnId, toolUseId] of [
      ["turn-1", "call-1"],
      ["turn-2", "call-2"],
    ] as const) {
      await expect(
        invokeNativeHookRelayBridge({
          provider: "codex",
          relayId,
          generation: "shared-generation",
          event: "post_tool_use",
          timeoutMs: 2_000,
          rawPayload: {
            hook_event_name: "PostToolUse",
            turn_id: turnId,
            tool_name: "Bash",
            tool_use_id: toolUseId,
            tool_input: { command: "/bin/echo ok" },
            tool_response: { output: "ok", exit_code: 0 },
          },
        }),
      ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    }

    expect(testing.getNativeHookRelayInvocationsForTests()).toMatchObject([
      { turnId: "turn-1", toolUseId: "call-1" },
      { turnId: "turn-2", toolUseId: "call-2" },
    ]);
    first.unregister();
    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId,
        generation: "shared-generation",
        event: "post_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PostToolUse",
          turn_id: "turn-1",
          tool_name: "Bash",
          tool_use_id: "late-call-1",
          tool_input: { command: "/bin/echo late" },
          tool_response: { output: "late", exit_code: 0 },
        },
      }),
    ).rejects.toThrow("native hook relay bridge stale registration");
    second.unregister();
  });

  it("separates reused turn ids by their exact native thread owners", async () => {
    const relayId = `overlapping-thread-turn-owners-${randomUUID()}`;
    const generation = "shared-generation";
    const first = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId,
      generation,
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    const second = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId,
      generation,
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });
    await Promise.all([first.ready, second.ready]);
    expect(first.claimTurn?.("turn-1", "thread-1")).toBe(true);
    expect(second.claimTurn?.("turn-1", "thread-2")).toBe(true);
    expect(second.claimTurn?.("turn-1", "thread-1")).toBe(false);

    const invoke = (threadId: string, toolUseId: string) =>
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId,
        generation,
        event: "post_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PostToolUse",
          session_id: threadId,
          turn_id: "turn-1",
          tool_name: "Bash",
          tool_use_id: toolUseId,
          tool_input: { command: "/bin/echo ok" },
          tool_response: { output: "ok", exit_code: 0 },
        },
      });

    await expect(invoke("thread-1", "call-1")).resolves.toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    await expect(invoke("thread-2", "call-2")).resolves.toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(testing.getNativeHookRelayInvocationsForTests()).toMatchObject([
      { runId: "run-1", turnId: "turn-1", toolUseId: "call-1" },
      { runId: "run-2", turnId: "turn-1", toolUseId: "call-2" },
    ]);

    first.unregister();
    await expect(invoke("thread-1", "late-call-1")).rejects.toThrow(
      "native hook relay bridge stale registration",
    );
    await expect(invoke("thread-2", "call-2-after-release")).resolves.toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    second.unregister();
  });

  it("verifies harmless startup policy and keeps protected mutations denied", async () => {
    const protectedPath = "/protected/ax3710-guard/index.js";
    const beforeToolCall = vi.fn(async () => ({}));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerAgentRelay({
      runId: "run-readiness",
      allowedEvents: ["pre_tool_use"],
    });
    await relay.ready;
    relay.claimTurn?.("turn-readiness");
    await expect(relay.verifyPreToolUse?.("turn-readiness")).resolves.toBeUndefined();

    for (const [toolUseId, command] of [
      ["pwd-canary", "pwd"],
      ["status-canary", "git status --short --branch"],
      ["echo-canary", "/bin/echo ok"],
    ] as const) {
      await expect(
        invokeNativeHookRelayBridge({
          provider: "codex",
          relayId: relay.relayId,
          generation: relay.generation,
          event: "pre_tool_use",
          timeoutMs: 2_000,
          rawPayload: {
            hook_event_name: "PreToolUse",
            turn_id: "turn-readiness",
            tool_name: "Bash",
            tool_use_id: toolUseId,
            tool_input: { command },
          },
        }),
      ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    }

    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: vi.fn(async () => ({
            block: true,
            blockReason: "protected enforcement infrastructure",
          })),
        },
      ]),
    );
    const protectedRelay = registerAgentRelay({
      runId: "run-protected-canary",
      allowedEvents: ["pre_tool_use"],
    });
    await protectedRelay.ready;
    protectedRelay.claimTurn?.("turn-protected-canary");
    const denied = await invokeNativeHookRelayBridge({
      provider: "codex",
      relayId: protectedRelay.relayId,
      generation: protectedRelay.generation,
      event: "pre_tool_use",
      timeoutMs: 2_000,
      rawPayload: {
        hook_event_name: "PreToolUse",
        turn_id: "turn-protected-canary",
        tool_name: "Bash",
        tool_use_id: "protected-mutation-canary",
        tool_input: { command: `/usr/bin/touch -r ${protectedPath} ${protectedPath}` },
      },
    });
    expect(JSON.parse(denied.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "protected enforcement infrastructure",
      },
    });
    protectedRelay.unregister();
    relay.unregister();
  });

  it("accepts an intentional policy denial as a serviced readiness probe", async () => {
    const policy = vi.fn(async () => ({
      block: true,
      blockReason: "fixture policy denied readiness",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: policy }]),
    );
    const relay = registerAgentRelay({
      runId: "run-denied-readiness",
      allowedEvents: ["pre_tool_use"],
    });
    await relay.ready;
    relay.claimTurn?.("turn-denied-readiness");

    await expect(relay.verifyPreToolUse?.("turn-denied-readiness")).resolves.toBeUndefined();
    expect(policy).toHaveBeenCalledOnce();
    relay.unregister();
  });

  it("keeps the readiness probe out of real execution custody without trusting its payload", async () => {
    const policy = vi.fn(async () => ({}));
    const admit = vi.fn(async () => {
      throw new Error("fixture execution admission rejected synthetic command");
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: policy }]),
    );
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: `readiness-admission-${randomUUID()}`,
      sessionId: "session-1",
      runId: "run-readiness-admission",
      allowedEvents: ["pre_tool_use"],
      executionAdmission: { toolNames: ["exec"], admit },
    });
    await relay.ready;
    expect(relay.claimTurn?.("turn-readiness-admission")).toBe(true);

    await expect(relay.verifyPreToolUse?.("turn-readiness-admission")).resolves.toBeUndefined();
    expect(policy).toHaveBeenCalledOnce();
    expect(admit).not.toHaveBeenCalled();

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: relay.relayId,
        generation: relay.generation,
        event: "pre_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PreToolUse",
          turn_id: "turn-readiness-admission",
          tool_name: "Bash",
          tool_use_id: `openclaw-relay-readiness-${randomUUID()}`,
          tool_input: { command: "/bin/echo ok" },
        },
      }),
    ).rejects.toThrow("fixture execution admission rejected synthetic command");
    expect(admit).toHaveBeenCalledOnce();
    relay.unregister();
  });
});
