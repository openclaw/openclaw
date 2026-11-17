// Covers relay-transport failure surfacing: bridge client disconnect, failure
// disposition attribution, and the consecutive-failure escalation to an error.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";

const { subsystemLogger } = vi.hoisted(() => {
  const logger = {
    subsystem: "test",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => logger,
  };
  return { subsystemLogger: logger };
});

vi.mock("../../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
  createSubsystemLogger: () => subsystemLogger,
}));

const { readNativeHookRelayBridgeRecord } = await import("./native-hook-relay-store.js");
const { isNativeHookRelayTransportFailedError } =
  await import("./native-hook-relay-transport-error.js");
const { NATIVE_HOOK_RELAY_BRIDGE_INVOCATION_DEADLINE_MS, recordNativeHookRelayTransportFailure } =
  await import("./native-hook-relay-transport-failure.js");
const {
  dispatchNativeHookRelayHttpCallback,
  invokeNativeHookRelay,
  registerNativeHookRelay,
  testing,
} = await import("./native-hook-relay.js");
const { handleNativeHookRelayBridgeRequest } = await import("./native-hook-relay-bridge.js");
const { nativeHookRelayState } = await import("./native-hook-relay-state.js");

/**
 * The escalation threshold, pinned here by behavior rather than imported.
 *
 * One transport failure is expected and recoverable inside the 250ms stable-id
 * replacement grace, and two can straddle one rotation window. Three
 * consecutive failures with no intervening success cannot be a rotation race.
 */
const TRANSPORT_FAILURE_THRESHOLD = 3;

type RelayHandle = ReturnType<typeof registerNativeHookRelay>;

afterEach(async () => {
  vi.useRealTimers();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await testing.clearNativeHookRelaysForTests();
  for (const mock of [
    subsystemLogger.trace,
    subsystemLogger.debug,
    subsystemLogger.info,
    subsystemLogger.warn,
    subsystemLogger.error,
    subsystemLogger.fatal,
    subsystemLogger.raw,
  ]) {
    mock.mockClear();
  }
});

function loggedMessages(mock: { mock: { calls: readonly (readonly unknown[])[] } }): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

function loggedMeta(
  mock: { mock: { calls: readonly (readonly unknown[])[] } },
  message: string,
): Record<string, unknown> | undefined {
  const call = mock.mock.calls.find((entry) => entry[0] === message);
  return call?.[1] as Record<string, unknown> | undefined;
}

function readTransportFailureCount(relayId: string): number {
  const registration = testing.getNativeHookRelayRegistrationForTests(relayId);
  // SAFETY: the internal registration carries transport-failure accounting that
  // the public registration type intentionally does not advertise.
  return (
    (registration as { relayTransportFailures?: { consecutive: number } } | undefined)
      ?.relayTransportFailures?.consecutive ?? 0
  );
}

function preToolUsePayload(toolCallId: string) {
  return {
    hook_event_name: "PreToolUse",
    cwd: "/repo",
    tool_name: "exec_command",
    tool_use_id: toolCallId,
    tool_input: { cmd: "pnpm test" },
  };
}

function postToolUsePayload(toolCallId: string) {
  return {
    hook_event_name: "PostToolUse",
    cwd: "/repo",
    tool_name: "exec_command",
    tool_use_id: toolCallId,
    tool_input: { cmd: "pnpm test" },
    tool_response: { exit_code: 0, stdout: "ok" },
  };
}

/** Post to the relay's real bridge and hand back the live socket. */
function openNativeHookRelayBridgeRequest(
  record: { hostname: string; port: number; token: string },
  payload: Record<string, unknown>,
): { destroy: () => void; failed: Promise<void> } {
  const body = JSON.stringify(payload);
  const req = httpRequest({
    hostname: record.hostname,
    method: "POST",
    path: "/invoke",
    port: record.port,
    headers: {
      authorization: `Bearer ${record.token}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  });
  const failed = new Promise<void>((resolve) => {
    req.on("error", () => resolve());
    req.on("close", () => resolve());
  });
  req.end(body);
  return { destroy: () => req.destroy(), failed };
}

async function registerRelayWithHangingBeforeToolCall(params: {
  relayId: string;
  onPreToolUseFailure: (failure: unknown) => void;
}): Promise<{ relay: RelayHandle; hookEntered: Promise<void> }> {
  let resolveEntered!: () => void;
  const hookEntered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_tool_call",
        handler: async () => {
          resolveEntered();
          // Never settles: this is the observed failure shape, where the parent
          // is still inside the invocation when the child gives up on it.
          await new Promise(() => {});
          return {};
        },
      },
    ]),
  );
  const relay = registerNativeHookRelay({
    provider: "codex",
    relayId: params.relayId,
    agentId: "agent-1",
    sessionId: "session-1",
    runId: "run-1",
    onPreToolUseFailure: params.onPreToolUseFailure,
  });
  return { relay, hookEntered };
}

describe("native hook relay bridge client disconnect", () => {
  it("does not charge a retired request's disconnect to the replacement relay", async () => {
    const oldFailure = vi.fn();
    const newFailure = vi.fn();
    const relayId = `codex-replaced-${randomUUID()}`;
    const { relay, hookEntered } = await registerRelayWithHangingBeforeToolCall({
      relayId,
      onPreToolUseFailure: oldFailure,
    });
    let record: Awaited<ReturnType<typeof readNativeHookRelayBridgeRecord>>;
    // The default 1s budget can race the shared-state broker's cold start when
    // this is the first bridge-record read in the process.
    await vi.waitFor(
      async () => {
        record = await readNativeHookRelayBridgeRecord({ relayId });
        expect(record?.relayId).toBe(relayId);
      },
      { timeout: 5_000 },
    );
    if (!record) {
      throw new Error("Expected the original relay bridge");
    }
    const request = openNativeHookRelayBridgeRequest(record, {
      provider: "codex",
      relayId,
      generation: relay.generation,
      event: "pre_tool_use",
      rawPayload: preToolUsePayload("retired-request"),
    });
    await hookEntered;
    const replacement = registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-2",
      onPreToolUseFailure: newFailure,
    });
    expect(replacement.generation).not.toBe(relay.generation);
    request.destroy();
    await request.failed;
    // Wait for the server-side abort to settle, not only the client's socket.
    await vi.waitFor(() => expect(oldFailure).toHaveBeenCalledOnce());
    expect(readTransportFailureCount(relayId)).toBe(0);
    expect(newFailure).not.toHaveBeenCalled();
  });

  it("warns, counts, and projects a failure when the client socket dies mid-invocation", async () => {
    const onPreToolUseFailure = vi.fn();
    const relayId = `codex-disconnect-${randomUUID()}`;
    const { relay, hookEntered } = await registerRelayWithHangingBeforeToolCall({
      relayId,
      onPreToolUseFailure,
    });
    let record: Awaited<ReturnType<typeof readNativeHookRelayBridgeRecord>>;
    // The default 1s budget can race the shared-state broker's cold start when
    // this is the first bridge-record read in the process.
    await vi.waitFor(
      async () => {
        record = await readNativeHookRelayBridgeRecord({ relayId });
        expect(record?.relayId).toBe(relayId);
      },
      { timeout: 5_000 },
    );
    if (!record) {
      throw new Error(`Expected a bridge record for ${relayId}`);
    }

    const request = openNativeHookRelayBridgeRequest(record, {
      provider: "codex",
      relayId,
      generation: relay.generation,
      event: "pre_tool_use",
      rawPayload: preToolUsePayload("native-disconnect-1"),
    });
    // Only destroy once the parent is genuinely inside the invocation; a socket
    // killed before that would prove nothing about an in-flight abort.
    await hookEntered;
    request.destroy();
    await request.failed;

    await vi.waitFor(() => {
      expect(loggedMessages(subsystemLogger.warn)).toContain(
        "native hook relay bridge client disconnected",
      );
    });
    expect(
      loggedMeta(subsystemLogger.warn, "native hook relay bridge client disconnected"),
    ).toMatchObject({
      relayId,
      event: "pre_tool_use",
      elapsedMs: expect.any(Number),
    });
    expect(readTransportFailureCount(relayId)).toBe(1);
    await vi.waitFor(() => {
      expect(onPreToolUseFailure).toHaveBeenCalledWith({
        toolName: "exec",
        toolCallId: "native-disconnect-1",
        disposition: "timed_out",
        durationMs: expect.any(Number),
      });
    });
  });
});

describe("native hook relay failure disposition attribution", () => {
  it("projects a transport disposition when the caller abandons the invocation", async () => {
    const onPreToolUseFailure = vi.fn();
    const relayId = `codex-abandoned-${randomUUID()}`;
    const { relay, hookEntered } = await registerRelayWithHangingBeforeToolCall({
      relayId,
      onPreToolUseFailure,
    });
    const controller = new AbortController();
    const invocation = invokeNativeHookRelay(
      {
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: preToolUsePayload("native-abandoned-1"),
      },
      controller.signal,
    );
    await hookEntered;
    controller.abort();

    // The abort itself keeps the shared relay contract; the transport verdict is
    // what the bridge names for a still-connected child, not this rejection.
    await expect(invocation).rejects.toThrow(/abort/i);
    expect(onPreToolUseFailure).toHaveBeenCalledWith({
      toolName: "exec",
      toolCallId: "native-abandoned-1",
      disposition: "timed_out",
      durationMs: expect.any(Number),
    });
  });

  it("leaves a policy denial without a failure disposition", async () => {
    const onPreToolUseFailure = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => ({ block: true, blockReason: "repo policy blocks this command" }),
        },
      ]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
      onPreToolUseFailure,
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: preToolUsePayload("native-policy-deny-1"),
    });

    expect(JSON.parse(response.stdout)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "repo policy blocks this command",
      },
    });
    // The whole point of the disposition: an OpenClaw policy deny is a hook that
    // ran fine, so it carries none and never reaches the failure projector.
    expect(response.failureDisposition).toBeUndefined();
    expect(onPreToolUseFailure).not.toHaveBeenCalled();
  });

  it("says nothing to the run owner when the child abandons an approval", async () => {
    const onPreToolUseFailure = vi.fn();
    const relayId = `codex-approval-projection-${randomUUID()}`;
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => ({}) }]),
    );
    let approvalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      approvalEntered = resolve;
    });
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(async () => {
      approvalEntered();
      await new Promise(() => {});
      return "deny";
    });
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
      onPreToolUseFailure,
    });
    let record: Awaited<ReturnType<typeof readNativeHookRelayBridgeRecord>>;
    // The default 1s budget can race the shared-state broker's cold start when
    // this is the first bridge-record read in the process.
    await vi.waitFor(
      async () => {
        record = await readNativeHookRelayBridgeRecord({ relayId });
        expect(record?.relayId).toBe(relayId);
      },
      { timeout: 5_000 },
    );
    if (!record) {
      throw new Error(`Expected a bridge record for ${relayId}`);
    }

    const request = openNativeHookRelayBridgeRequest(record, {
      provider: "codex",
      relayId,
      generation: relay.generation,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-approval-projection-1",
        tool_input: { command: "git status" },
      },
    });
    // Exactly how the child's own hook budget gives up: mid-approval, with the
    // person still free to answer Codex's native prompt afterwards.
    await entered;
    request.destroy();
    await request.failed;
    await vi.waitFor(() => {
      expect(loggedMessages(subsystemLogger.warn)).toContain(
        "native hook relay approval wait outlived its transport budget",
      );
    });

    // A later invocation is a second settling point: anything the disconnect
    // scheduled has run by the time this resolves.
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: preToolUsePayload("native-after-abandoned-approval"),
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(onPreToolUseFailure).not.toHaveBeenCalled();
  });

  it("says nothing for an abandoned approval's server deadline either", async () => {
    const onPreToolUseFailure = vi.fn();
    const relayId = `codex-approval-deadline-projection-${randomUUID()}`;
    registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
      onPreToolUseFailure,
    });

    for (const event of ["permission_request", "pre_tool_use"] as const) {
      recordNativeHookRelayTransportFailure({
        relayId,
        cause: "server-deadline",
        event,
        elapsedMs: NATIVE_HOOK_RELAY_BRIDGE_INVOCATION_DEADLINE_MS,
        toolName: "shell",
        toolCallId: `native-deadline-${event}`,
      });
    }

    // Projection is scheduled, not immediate, so the pre-tool-use call recorded
    // second is the settling point: once it has landed, anything the approval
    // scheduled first would already have landed too.
    await vi.waitFor(() => {
      expect(onPreToolUseFailure).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: "native-deadline-pre_tool_use" }),
      );
    });
    expect(onPreToolUseFailure).toHaveBeenCalledTimes(1);
  });

  it("says nothing to the run owner when the child abandons a post-tool-use hook", async () => {
    const onPreToolUseFailure = vi.fn();
    const relayId = `codex-post-tool-projection-${randomUUID()}`;
    let afterToolCallEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      afterToolCallEntered = resolve;
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "after_tool_call",
          handler: async () => {
            afterToolCallEntered();
            // The observed shape: the parent is still inside the observation when
            // the child's own hook budget gives up on a call that already ran.
            await new Promise(() => {});
            return {};
          },
        },
      ]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
      onPreToolUseFailure,
    });
    let record: Awaited<ReturnType<typeof readNativeHookRelayBridgeRecord>>;
    // The default 1s budget can race the shared-state broker's cold start when
    // this is the first bridge-record read in the process.
    await vi.waitFor(
      async () => {
        record = await readNativeHookRelayBridgeRecord({ relayId });
        expect(record?.relayId).toBe(relayId);
      },
      { timeout: 5_000 },
    );
    if (!record) {
      throw new Error(`Expected a bridge record for ${relayId}`);
    }

    const request = openNativeHookRelayBridgeRequest(record, {
      provider: "codex",
      relayId,
      generation: relay.generation,
      event: "post_tool_use",
      rawPayload: postToolUsePayload("native-post-tool-projection-1"),
    });
    await entered;
    request.destroy();
    await request.failed;
    // The record site ran and attributed the failure to this event — the
    // projection is withheld on purpose, not missed because nothing happened.
    await vi.waitFor(() => {
      expect(loggedMeta(subsystemLogger.warn, "native hook relay transport failure")).toMatchObject(
        {
          relayId,
          event: "post_tool_use",
        },
      );
    });

    // A later invocation is a second settling point: anything the disconnect
    // scheduled has run by the time this resolves.
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: preToolUsePayload("native-after-abandoned-post-tool"),
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(onPreToolUseFailure).not.toHaveBeenCalled();
  });

  it("says nothing for an abandoned post-tool-use hook's server deadline either", async () => {
    const onPreToolUseFailure = vi.fn();
    const relayId = `codex-post-tool-deadline-projection-${randomUUID()}`;
    registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
      onPreToolUseFailure,
    });

    for (const event of ["post_tool_use", "pre_tool_use"] as const) {
      recordNativeHookRelayTransportFailure({
        relayId,
        cause: "server-deadline",
        event,
        elapsedMs: NATIVE_HOOK_RELAY_BRIDGE_INVOCATION_DEADLINE_MS,
        toolName: "shell",
        toolCallId: `native-post-deadline-${event}`,
      });
    }

    // Projection is scheduled, not immediate, so the pre-tool-use call recorded
    // second is the settling point: once it has landed, anything the post-tool-use
    // failure scheduled first would already have landed too.
    await vi.waitFor(() => {
      expect(onPreToolUseFailure).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: "native-post-deadline-pre_tool_use" }),
      );
    });
    expect(onPreToolUseFailure).toHaveBeenCalledTimes(1);
  });

  it("still projects a pre-tool-use failure the child fail-closed denied", async () => {
    const onPreToolUseFailure = vi.fn();
    const relayId = `codex-pre-tool-projection-${randomUUID()}`;
    registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
      onPreToolUseFailure,
    });

    // The contrast that makes the approval exemption safe: an abandoned
    // pre-tool-use hook really did stop the tool call, on both causes.
    for (const cause of ["client-disconnected", "server-deadline"] as const) {
      recordNativeHookRelayTransportFailure({
        relayId,
        cause,
        event: "pre_tool_use",
        elapsedMs: 9_000,
        toolName: "exec",
        toolCallId: `native-pre-tool-${cause}`,
      });
    }

    await vi.waitFor(() => {
      expect(onPreToolUseFailure).toHaveBeenCalledTimes(2);
    });
    expect(onPreToolUseFailure).toHaveBeenCalledWith({
      toolName: "exec",
      toolCallId: "native-pre-tool-client-disconnected",
      disposition: "timed_out",
      durationMs: 9_000,
    });
  });
});

describe("native hook relay transport failure escalation", () => {
  function registerEscalationRelay(relayId: string): RelayHandle {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => ({}) }]),
    );
    return registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
    });
  }

  function failTransport(relayId: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
      recordNativeHookRelayTransportFailure({
        relayId,
        cause: "client-disconnected",
        event: "pre_tool_use",
        elapsedMs: 10,
      });
    }
  }

  it("keeps serving invocations below the consecutive failure threshold", async () => {
    const relayId = `codex-below-threshold-${randomUUID()}`;
    const relay = registerEscalationRelay(relayId);
    failTransport(relayId, TRANSPORT_FAILURE_THRESHOLD - 1);

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: preToolUsePayload("native-below-threshold-1"),
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(loggedMessages(subsystemLogger.error)).not.toContain(
      "native hook relay transport failed",
    );
  });

  it("refuses every later invocation with an explicit error once the threshold trips", async () => {
    const relayId = `codex-at-threshold-${randomUUID()}`;
    const relay = registerEscalationRelay(relayId);
    failTransport(relayId, TRANSPORT_FAILURE_THRESHOLD);

    expect(loggedMeta(subsystemLogger.error, "native hook relay transport failed")).toMatchObject({
      relayId,
      cause: "client-disconnected",
      consecutiveFailures: TRANSPORT_FAILURE_THRESHOLD,
      threshold: TRANSPORT_FAILURE_THRESHOLD,
    });
    for (const attempt of ["native-at-threshold-1", "native-at-threshold-2"]) {
      const failure = await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: preToolUsePayload(attempt),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(isNativeHookRelayTransportFailedError(failure)).toBe(true);
    }
  });

  it("resets the consecutive counter after an invocation completes end to end", async () => {
    const relayId = `codex-reset-${randomUUID()}`;
    const relay = registerEscalationRelay(relayId);
    failTransport(relayId, TRANSPORT_FAILURE_THRESHOLD - 1);
    expect(readTransportFailureCount(relayId)).toBe(TRANSPORT_FAILURE_THRESHOLD - 1);

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: preToolUsePayload("native-reset-1"),
    });
    expect(readTransportFailureCount(relayId)).toBe(0);

    failTransport(relayId, TRANSPORT_FAILURE_THRESHOLD - 1);
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: preToolUsePayload("native-reset-2"),
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("does not latch the relay terminal while a person is still deciding", async () => {
    const relayId = `codex-approval-wait-${randomUUID()}`;
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => ({}) }]),
    );
    // The approval a person owns: entered, then never answered inside any
    // transport budget. Codex's hookTimeoutSec is what runs out first.
    const approvalEntered: (() => void)[] = [];
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(async () => {
      approvalEntered.shift()?.();
      await new Promise(() => {});
      return "deny";
    });
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
    });
    let record: Awaited<ReturnType<typeof readNativeHookRelayBridgeRecord>>;
    // The default 1s budget can race the shared-state broker's cold start when
    // this is the first bridge-record read in the process.
    await vi.waitFor(
      async () => {
        record = await readNativeHookRelayBridgeRecord({ relayId });
        expect(record?.relayId).toBe(relayId);
      },
      { timeout: 5_000 },
    );
    if (!record) {
      throw new Error(`Expected a bridge record for ${relayId}`);
    }

    for (let attempt = 1; attempt <= TRANSPORT_FAILURE_THRESHOLD; attempt += 1) {
      const entered = new Promise<void>((resolve) => {
        approvalEntered.push(resolve);
      });
      const request = openNativeHookRelayBridgeRequest(record, {
        provider: "codex",
        relayId,
        generation: relay.generation,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          cwd: "/repo",
          tool_name: "Bash",
          tool_use_id: `native-approval-${attempt}`,
          tool_input: { command: "git status" },
        },
      });
      // Give up exactly the way the child's own hook budget does: mid-approval.
      await entered;
      request.destroy();
      await request.failed;
      // The parent logs the disconnect before it decides what the disconnect
      // means, so this is the settling point for both the charged and the
      // excused verdict.
      await vi.waitFor(() => {
        expect(
          loggedMessages(subsystemLogger.warn).filter(
            (message) => message === "native hook relay bridge client disconnected",
          ),
        ).toHaveLength(attempt);
      });
      expect(readTransportFailureCount(relayId)).toBe(0);
      expect(loggedMessages(subsystemLogger.warn)).toContain(
        "native hook relay approval wait outlived its transport budget",
      );
    }
    expect(loggedMessages(subsystemLogger.error)).not.toContain(
      "native hook relay transport failed",
    );
    // The relay is the side that held the prompt open, so it still serves.
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: preToolUsePayload("native-after-approval-waits"),
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("still counts a failure cause the outstanding approval cannot explain", () => {
    const relayId = `codex-approval-cause-${randomUUID()}`;
    registerEscalationRelay(relayId);
    nativeHookRelayState.pendingPermissionApprovals.set(`${relayId}-pending`, {
      relayId,
      controller: new AbortController(),
      waiters: 1,
      cancelWhenUnobserved: false,
      promise: new Promise(() => {}),
    });

    // The child's own fail-closed verdicts are not observations of a parent that
    // is still serving the invocation, so a pending approval never excuses them.
    for (const cause of ["relay-timeout", "relay-unavailable"] as const) {
      recordNativeHookRelayTransportFailure({
        relayId,
        cause,
        event: "permission_request",
        elapsedMs: 5,
      });
    }
    expect(readTransportFailureCount(relayId)).toBe(2);

    // The two the parent raises while it holds the prompt open are excused.
    for (const cause of ["client-disconnected", "server-deadline"] as const) {
      recordNativeHookRelayTransportFailure({
        relayId,
        cause,
        event: "permission_request",
        elapsedMs: 30_000,
      });
    }
    expect(readTransportFailureCount(relayId)).toBe(2);
  });

  it("re-arms the server deadline instead of tripping it on an outstanding approval", async () => {
    const relayId = `codex-approval-deadline-${randomUUID()}`;
    const relay = registerEscalationRelay(relayId);
    let approvalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      approvalEntered = resolve;
    });
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(async () => {
      approvalEntered();
      await new Promise(() => {});
      return "deny";
    });
    let record: Awaited<ReturnType<typeof readNativeHookRelayBridgeRecord>>;
    // The default 1s budget can race the shared-state broker's cold start when
    // this is the first bridge-record read in the process.
    await vi.waitFor(
      async () => {
        record = await readNativeHookRelayBridgeRecord({ relayId });
        expect(record?.relayId).toBe(relayId);
      },
      { timeout: 5_000 },
    );
    if (!record) {
      throw new Error(`Expected a bridge record for ${relayId}`);
    }
    // Installed before the request so the invocation's own deadline timer is
    // the fake one this test advances.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const request = openNativeHookRelayBridgeRequest(record, {
      provider: "codex",
      relayId,
      generation: relay.generation,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-slow-approval",
        tool_input: { command: "git status" },
      },
    });
    try {
      await entered;
      // Two full ceilings of a person reading the prompt. An operator who raises
      // Codex's hookTimeoutSec past this window must still get their answer.
      await vi.advanceTimersByTimeAsync(
        NATIVE_HOOK_RELAY_BRIDGE_INVOCATION_DEADLINE_MS * 2 + 1_000,
      );
      vi.useRealTimers();

      expect(loggedMessages(subsystemLogger.warn)).not.toContain(
        "native hook relay bridge invocation deadline exceeded",
      );
      expect(readTransportFailureCount(relayId)).toBe(0);
      expect(nativeHookRelayState.pendingPermissionApprovals.size).toBe(1);
    } finally {
      vi.useRealTimers();
      request.destroy();
      await request.failed;
    }
  });

  it("holds the server deadline for a relay admitted with a longer command budget", async () => {
    const relayId = `codex-budget-deadline-${randomUUID()}`;
    const exceeded = "native hook relay bridge invocation deadline exceeded";
    let hookEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      hookEntered = resolve;
    });
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-1",
      runId: "run-1",
      // Stands in for workspace readiness, which waits inside the host pre-tool call.
      runBeforeToolCall: async () => {
        hookEntered();
        return await new Promise<never>(() => {});
      },
      command: { timeoutMs: NATIVE_HOOK_RELAY_BRIDGE_INVOCATION_DEADLINE_MS + 20_000 },
    });
    let record: Awaited<ReturnType<typeof readNativeHookRelayBridgeRecord>>;
    await vi.waitFor(
      async () => {
        record = await readNativeHookRelayBridgeRecord({ relayId });
        expect(record?.relayId).toBe(relayId);
      },
      { timeout: 5_000 },
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const request = openNativeHookRelayBridgeRequest(record!, {
      provider: "codex",
      relayId,
      generation: relay.generation,
      event: "pre_tool_use",
      rawPayload: preToolUsePayload("native-slow-readiness"),
    });
    try {
      await entered;
      await vi.advanceTimersByTimeAsync(NATIVE_HOOK_RELAY_BRIDGE_INVOCATION_DEADLINE_MS + 10_000);
      expect(loggedMessages(subsystemLogger.warn)).not.toContain(exceeded);
      // The admitted budget is still a ceiling, not an exemption.
      await vi.advanceTimersByTimeAsync(11_000);
      expect(loggedMessages(subsystemLogger.warn)).toContain(exceeded);
    } finally {
      vi.useRealTimers();
      request.destroy();
      await request.failed;
    }
  });

  it("names the latched terminal failure to a remote callback", async () => {
    const relayId = `codex-remote-terminal-${randomUUID()}`;
    const relay = registerEscalationRelay(relayId);
    const bridge = nativeHookRelayState.relayBridges.get(relayId)!;
    bridge.remoteEnabled = true;
    failTransport(relayId, TRANSPORT_FAILURE_THRESHOLD);
    const server = createServer((req, res) => {
      void dispatchNativeHookRelayHttpCallback(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/__openclaw__/native-hook/${relayId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({
          provider: "codex",
          relayId,
          generation: relay.generation,
          event: "pre_tool_use",
          rawPayload: preToolUsePayload("native-remote-terminal"),
        }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        ok: false,
        error: "native hook relay transport failed",
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    }
  });

  it("does not charge an unauthenticated disconnect to the relay", async () => {
    const relayId = `codex-unauthenticated-disconnect-${randomUUID()}`;
    registerEscalationRelay(relayId);
    const bridge = nativeHookRelayState.relayBridges.get(relayId)!;
    // The socket died before the handler ran, so the abort signal starts aborted.
    const req = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/invoke",
      headers: { authorization: "Bearer stale-token" },
      destroyed: true,
      complete: false,
      socket: { destroyed: true },
    });
    const res = Object.assign(new EventEmitter(), {
      destroyed: true,
      writableFinished: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    });
    await handleNativeHookRelayBridgeRequest(req as never, res as never, {
      provider: "codex",
      relayId,
      token: bridge.token,
      registration: testing.getNativeHookRelayRegistrationForTests(relayId) as never,
      bridge,
      invokeRelay: invokeNativeHookRelay,
    });

    expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
    expect(readTransportFailureCount(relayId)).toBe(0);
  });

  it("keeps the streak accounting the withheld projection does not own", () => {
    const relayId = `codex-approval-streak-${randomUUID()}`;
    registerEscalationRelay(relayId);
    const approvalKey = `${relayId}-pending`;
    nativeHookRelayState.pendingPermissionApprovals.set(approvalKey, {
      relayId,
      controller: new AbortController(),
      waiters: 1,
      cancelWhenUnobserved: false,
      promise: new Promise(() => {}),
    });

    // Withholding the projection must not also withhold — or fabricate — the
    // relay's health verdict. An excused approval wait still costs nothing.
    recordNativeHookRelayTransportFailure({
      relayId,
      cause: "client-disconnected",
      event: "permission_request",
      elapsedMs: 9_000,
      toolName: "shell",
      toolCallId: "native-approval-streak-1",
    });
    expect(readTransportFailureCount(relayId)).toBe(0);

    // Once nobody is deciding, a genuine failure still latches at the threshold.
    nativeHookRelayState.pendingPermissionApprovals.delete(approvalKey);
    failTransport(relayId, TRANSPORT_FAILURE_THRESHOLD);
    expect(readTransportFailureCount(relayId)).toBe(TRANSPORT_FAILURE_THRESHOLD);
    expect(loggedMeta(subsystemLogger.error, "native hook relay transport failed")).toMatchObject({
      relayId,
      consecutiveFailures: TRANSPORT_FAILURE_THRESHOLD,
    });
  });

  it("still charges an abandoned post-tool-use hook to the relay's health streak", () => {
    const relayId = `codex-post-tool-streak-${randomUUID()}`;
    registerEscalationRelay(relayId);

    // Withholding the tool call's fate must not also withhold the relay's own
    // health verdict: unlike an excused approval wait, a dead transport under a
    // post-tool-use hook is a real transport failure and still counts.
    for (let index = 0; index < TRANSPORT_FAILURE_THRESHOLD; index += 1) {
      recordNativeHookRelayTransportFailure({
        relayId,
        cause: "client-disconnected",
        event: "post_tool_use",
        elapsedMs: 9_000,
        toolName: "exec",
        toolCallId: `native-post-tool-streak-${index}`,
      });
    }

    expect(readTransportFailureCount(relayId)).toBe(TRANSPORT_FAILURE_THRESHOLD);
    expect(loggedMeta(subsystemLogger.error, "native hook relay transport failed")).toMatchObject({
      relayId,
      cause: "client-disconnected",
      consecutiveFailures: TRANSPORT_FAILURE_THRESHOLD,
    });
  });

  it("ignores transport failures reported for a relay that is already gone", () => {
    expect(
      recordNativeHookRelayTransportFailure({
        relayId: `codex-missing-${randomUUID()}`,
        cause: "relay-unavailable",
      }),
    ).toBeUndefined();
  });
});
