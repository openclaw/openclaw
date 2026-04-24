import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  buildNativeHookRelayCommand,
  invokeNativeHookRelay,
  registerNativeHookRelay,
} from "./native-hook-relay.js";

afterEach(() => {
  vi.useRealTimers();
  __testing.clearNativeHookRelaysForTests();
});

describe("native hook relay registry", () => {
  it("registers a short-lived relay and builds hidden CLI commands", () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
      ttlMs: 10_000,
      command: {
        executable: "/opt/Open Claw/openclaw.mjs",
        nodeExecutable: "/usr/local/bin/node",
        timeoutMs: 1234,
      },
    });

    expect(__testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toMatchObject({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });
    expect(relay.commandForEvent("pre_tool_use")).toBe(
      "/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id " +
        `${relay.relayId} --event pre_tool_use --timeout 1234`,
    );
  });

  it("accepts an allowed Codex invocation and preserves raw payload for later mapping", () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });

    const response = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        model: "gpt-5.4",
        tool_name: "Bash",
        tool_use_id: "call-1",
        tool_input: { command: "pnpm test" },
      },
    });

    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(__testing.getNativeHookRelayInvocationsForTests()).toEqual([
      expect.objectContaining({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        nativeEventName: "PreToolUse",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        cwd: "/repo",
        model: "gpt-5.4",
        toolName: "Bash",
        toolUseId: "call-1",
        rawPayload: expect.objectContaining({
          tool_input: { command: "pnpm test" },
        }),
      }),
    ]);
  });

  it("rejects missing, wrong-provider, and disallowed-event invocations", () => {
    expect(() =>
      invokeNativeHookRelay({
        provider: "codex",
        relayId: "missing",
        event: "pre_tool_use",
        rawPayload: {},
      }),
    ).toThrow("not found");

    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });

    expect(() =>
      invokeNativeHookRelay({
        provider: "claude-code",
        relayId: relay.relayId,
        event: "post_tool_use",
        rawPayload: {},
      }),
    ).toThrow("unsupported");

    expect(() =>
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {},
      }),
    ).toThrow("not allowed");
  });

  it("rejects expired relay ids", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00Z"));
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      ttlMs: 1,
    });

    vi.setSystemTime(new Date("2026-04-24T12:00:01Z"));

    expect(() =>
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {},
      }),
    ).toThrow("expired");
  });

  it("uses the Codex no-op output for all v1 relay events", () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    for (const event of ["pre_tool_use", "post_tool_use", "permission_request"] as const) {
      expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event,
          rawPayload: { hook_event_name: event },
        }),
      ).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    }
  });
});

describe("native hook relay command builder", () => {
  it("uses the Codex hook relay command shape", () => {
    expect(
      buildNativeHookRelayCommand({
        provider: "codex",
        relayId: "relay-1",
        event: "permission_request",
        executable: "openclaw",
      }),
    ).toBe(
      "openclaw hooks relay --provider codex --relay-id relay-1 --event permission_request --timeout 5000",
    );
  });
});
