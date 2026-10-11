import { randomUUID } from "node:crypto";
import { request as httpRequest, Server } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
// Covers native hook relay registration, bridge invocation, and approval state.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runNativeHookRelayCliFromArgvForTest } from "../../cli/native-hook-relay-cli.test-support.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import { mintAgentRuntimeIdentityToken } from "../../gateway/agent-runtime-identity-token.js";
import { nativeHookRelayHandlers } from "../../gateway/server-methods/native-hook-relay.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { validateAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { patchPluginSessionExtension } from "../../plugins/host-hook-state.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { splitShellArgs } from "../../utils/shell-argv.js";
import {
  closeAdmittedRunDelegatedAuthority,
  getAdmittedRunDelegatedAuthority,
} from "../admitted-run-context.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import * as nativeHookRelayBridge from "./native-hook-relay-bridge.js";
import { invokeNativeHookRelayBridge } from "./native-hook-relay-client.js";
import * as nativeHookRelayStore from "./native-hook-relay-store.js";
import type { NativeHookRelayBridgeRecord } from "./native-hook-relay-store.js";
import {
  registerOwnedNativeHookRelay,
  testing,
  buildNativeHookRelayCommand,
  hasNativeHookRelayInvocation,
  invokeNativeHookRelay,
  registerNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
} from "./native-hook-relay.js";
import {
  clearNativeHookRelaysForTests,
  createNativeHookRelayPermissionRequestFixture as createPermissionRequestFixture,
} from "./native-hook-relay.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-native-relay-policy-");

const NATIVE_HOOK_RELAY_EXEC_PREFIX = process.platform === "win32" ? "" : "exec ";

function registerRelay(overrides: Partial<Parameters<typeof registerNativeHookRelay>[0]> = {}) {
  return registerNativeHookRelay({
    provider: "codex",
    sessionId: "session-1",
    runId: "run-1",
    ...overrides,
  });
}

function registerOwnedRelay(
  overrides: Partial<Parameters<typeof registerOwnedNativeHookRelay>[0]> = {},
) {
  return registerOwnedNativeHookRelay({
    provider: "codex",
    sessionId: "session-1",
    runId: "run-1",
    ...overrides,
  });
}
function invokeRelay(
  relayId: string,
  event: Parameters<typeof invokeNativeHookRelay>[0]["event"],
  rawPayload: unknown,
  options: Omit<
    Parameters<typeof invokeNativeHookRelay>[0],
    "provider" | "relayId" | "event" | "rawPayload"
  > = {},
) {
  return invokeNativeHookRelay({ provider: "codex", relayId, event, rawPayload, ...options });
}

function registerAgentRelay(
  overrides: Partial<Parameters<typeof registerNativeHookRelay>[0]> = {},
) {
  return registerRelay({
    agentId: "agent-1",
    sessionKey: "agent:main:session-1",
    ...overrides,
  });
}

function readTestNativeAgentId(rawPayload: unknown): string | undefined {
  if (!isRecord(rawPayload) || typeof rawPayload.agent_id !== "string") {
    return undefined;
  }
  return rawPayload.agent_id.trim() || undefined;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await clearNativeHookRelaysForTests();
});

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function readRecordField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function getMockCallArg(
  mock: { mock: { calls: readonly (readonly unknown[])[] } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  return requireRecord(mock.mock.calls[callIndex]?.[argIndex], label);
}

function getOnlyNativeHookRelayInvocation() {
  const invocations = testing.getNativeHookRelayInvocationsForTests();
  expect(invocations).toHaveLength(1);
  return requireRecord(invocations[0], "native hook relay invocation");
}

async function waitForNativeHookRelayBridgeRecord(
  relayId: string,
): Promise<NativeHookRelayBridgeRecord> {
  let record: NativeHookRelayBridgeRecord | undefined;
  await vi.waitFor(async () => {
    record = await nativeHookRelayStore.readNativeHookRelayBridgeRecord({ relayId });
    expect(record?.relayId).toBe(relayId);
  });
  if (!record) {
    throw new Error(`Expected native hook relay bridge record for ${relayId}`);
  }
  return record;
}

async function writeForeignNativeHookRelayBridgeRecordForTests(
  relayId: string,
  record: {
    pid: number;
    expiresAtMs: number;
  },
): Promise<string> {
  await nativeHookRelayStore.writeNativeHookRelayBridgeRecord({
    record: {
      relayId,
      pid: record.pid,
      hostname: "127.0.0.1",
      port: 9,
      token: "test-token-placeholder",
      expiresAtMs: record.expiresAtMs,
    },
  });
  return relayId;
}

function uniqueNativeHookRelayIdForTests(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function nativeHookRelayStateDbArgForTests(): string {
  return `--state-db ${resolveOpenClawStateSqlitePath()}`;
}

function openDeferredNativeHookRelayBridgeRequest(
  record: Pick<NativeHookRelayBridgeRecord, "hostname" | "port" | "token">,
  payload: Record<string, unknown>,
): {
  connected: Promise<void>;
  response: Promise<Record<string, unknown>>;
  sendBody: () => void;
} {
  const body = JSON.stringify(payload);
  let settled = false;
  let resolveResponse!: (value: Record<string, unknown>) => void;
  let rejectResponse!: (error: unknown) => void;
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const req = httpRequest(
    {
      hostname: record.hostname,
      method: "POST",
      path: "/invoke",
      port: record.port,
      headers: {
        authorization: `Bearer ${record.token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    },
    (res) => {
      let responseText = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        responseText += typeof chunk === "string" ? chunk : String(chunk);
      });
      res.on("error", rejectResponse);
      res.on("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        resolveResponse(requireRecord(JSON.parse(responseText), "bridge response"));
      });
    },
  );
  const connected = new Promise<void>((resolve, reject) => {
    req.on("socket", (socket) => {
      socket.on("error", reject);
      if (socket.connecting) {
        socket.once("connect", resolve);
        return;
      }
      resolve();
    });
  });
  req.on("error", (error) => {
    if (!settled) {
      settled = true;
      rejectResponse(error);
    }
  });
  req.flushHeaders();
  return {
    connected,
    response,
    sendBody: () => req.end(body),
  };
}

type NativeHookRelaySharedStateForTests = {
  relays: Map<string, unknown>;
  pendingPermissionApprovals: Map<string, unknown>;
  permissionAllowAlwaysApprovals: Map<string, unknown>;
};

function getNativeHookRelaySharedStateForTests(): NativeHookRelaySharedStateForTests {
  // Native relay state is intentionally shared on globalThis so duplicate
  // module imports in one process still see one approval/bridge registry.
  const state = (
    globalThis as typeof globalThis & {
      [key: symbol]: NativeHookRelaySharedStateForTests | undefined;
    }
  )[Symbol.for("openclaw.nativeHookRelay.state")];
  if (!state) {
    throw new Error("Expected native hook relay shared state to be initialized");
  }
  return state;
}

type NativeHookRelayModuleForTests = typeof import("./native-hook-relay.js");

async function importDuplicateNativeHookRelayModuleForTests(): Promise<NativeHookRelayModuleForTests> {
  vi.resetModules();
  return import("./native-hook-relay.js");
}

describe("native hook relay registry", () => {
  it("registers a short-lived relay and builds hidden CLI commands", () => {
    const relay = registerAgentRelay({
      allowedEvents: ["pre_tool_use"],
      ttlMs: 10_000,
      command: {
        executable: "/opt/Open Claw/openclaw.mjs",
        nodeExecutable: "/usr/local/bin/node",
        timeoutMs: 1234,
      },
    });

    expectRecordFields(
      requireRecord(
        testing.getNativeHookRelayRegistrationForTests(relay.relayId),
        "native hook relay registration",
      ),
      {
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        allowedEvents: ["pre_tool_use"],
      },
    );
    expect(relay.commandForEvent("pre_tool_use")).toBe(
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id ` +
        `${relay.relayId} ${nativeHookRelayStateDbArgForTests()} --generation ${relay.generation} --event pre_tool_use --timeout 1234`,
    );
    expect(relay.commandForEvent("pre_tool_use", { timeoutMs: 900 })).toBe(
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id ` +
        `${relay.relayId} ${nativeHookRelayStateDbArgForTests()} --generation ${relay.generation} --event pre_tool_use --timeout 900`,
    );
    expect(relay.commandForEvent("pre_tool_use", { timeoutMs: 2_000 })).toBe(
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id ` +
        `${relay.relayId} ${nativeHookRelayStateDbArgForTests()} --generation ${relay.generation} --event pre_tool_use --timeout 1234`,
    );
  });

  it("rejects relay registrations when expiry would exceed Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    expect(() => registerRelay({ allowedEvents: ["pre_tool_use"] })).toThrow(
      "Native hook relay expiry is outside the supported Date range",
    );
  });

  it("rejects a bound pre-tool policy result after exact host authority closes", async () => {
    let active = true;
    const admitExecution = vi.fn();
    let resolvePolicy:
      | ((value: { blocked: false; params: Record<string, unknown> }) => void)
      | undefined;
    const runBeforeToolCall = vi.fn(
      () =>
        new Promise<{ blocked: false; params: Record<string, unknown> }>((resolve) => {
          resolvePolicy = resolve;
        }),
    );
    const relay = registerOwnedRelay({
      relayId: "codex-bound-authority-close",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall,
      executionAdmission: { toolNames: ["exec"], admit: admitExecution },
      assertActive: () => {
        if (!active) {
          throw new Error("agent harness host capability is no longer active");
        }
      },
    });
    const invocation = invokeRelay(relay.relayId, "pre_tool_use", {
      hook_event_name: "PreToolUse",
      openclaw_approval_mode: "report",
      cwd: "/repo",
      tool_name: "Bash",
      tool_use_id: "native-close-1",
      tool_input: { command: "git status" },
    });
    await vi.waitFor(() => expect(runBeforeToolCall).toHaveBeenCalledTimes(1));
    active = false;
    resolvePolicy?.({ blocked: false, params: { command: "git status" } });

    await expect(invocation).rejects.toThrow("agent harness host capability is no longer active");
    expect(admitExecution).not.toHaveBeenCalled();
    expect(runBeforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: "defer",
        nativeOperation: { cwd: "/repo" },
      }),
    );
  });

  it("rejects an in-flight root policy after foreground close while a child retains the relay", async () => {
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId: "run-root-foreground-close",
    });
    let resolvePolicy: ((value: undefined) => void) | undefined;
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: () =>
            new Promise<undefined>((resolve) => {
              resolvePolicy = resolve;
            }),
        },
      ]),
    );
    const relay = registerOwnedRelay({
      relayId: "codex-root-foreground-close",
      runId: "run-root-foreground-close",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => true,
        allowPreToolUse: () => false,
        onDispose: () => {},
      },
    });
    const invocation = invokeRelay(relay.relayId, "pre_tool_use", {
      hook_event_name: "PreToolUse",
      openclaw_approval_mode: "report",
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
    await vi.waitFor(() => {
      expect(resolvePolicy).toBeTypeOf("function");
    });
    relay.unregister();
    await relay.drain();
    resolvePolicy?.(undefined);

    await expect(invocation).rejects.toThrow("foreground invocation not allowed");
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeDefined();
    closeAdmittedRunDelegatedAuthority(admittedRunContext);
    relay.unregister();
  });

  it("retires a retained relay at lifecycle rotation and keeps its same-id successor", async () => {
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId: "run-retained-rotation",
    });
    let successor: ReturnType<typeof registerOwnedRelay> | undefined;
    const onDispose = vi.fn(() => {
      successor = registerOwnedRelay({
        relayId: "codex-retained-rotation",
        runId: "run-rotation-successor",
        allowedEvents: ["pre_tool_use"],
      });
    });
    const relay = registerOwnedRelay({
      relayId: "codex-retained-rotation",
      runId: "run-retained-rotation",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => true,
        allowPreToolUse: (claim) => claim === "child-thread",
        onDispose,
      },
    });
    await relay.ready;
    relay.unregister();
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)?.runId).toBe(
      "run-retained-rotation",
    );

    rotateAgentEventLifecycleGeneration();

    expect(onDispose).toHaveBeenCalledOnce();
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)?.runId).toBe(
      "run-rotation-successor",
    );
    rotateAgentEventLifecycleGeneration();
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
    successor?.unregister();
    closeAdmittedRunDelegatedAuthority(admittedRunContext);
  });

  it("keeps only a claimed flat native child after foreground cleanup", async () => {
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId: "run-retained-child",
    });
    const delegatedAuthority = getAdmittedRunDelegatedAuthority(admittedRunContext);
    if (!delegatedAuthority) {
      throw new Error("Expected admitted delegated authority");
    }
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const approvalRequester = vi.fn(async () => "allow" as const);
    const admitExecution = vi.fn();
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);
    let retainChild = true;
    const relay = registerOwnedRelay({
      relayId: "codex-retained-direct-child",
      runId: "run-retained-child",
      allowedEvents: ["pre_tool_use", "permission_request", "post_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      executionAdmission: { toolNames: ["exec"], admit: admitExecution },
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => retainChild,
        allowPreToolUse: (claim) => claim === "child-thread",
        onDispose: () => {},
      },
    });
    const invoke = (
      event: Parameters<typeof invokeNativeHookRelay>[0]["event"],
      rawPayload: unknown,
    ) => invokeRelay(relay.relayId, event, rawPayload);

    await expect(
      invoke("pre_tool_use", { tool_name: "Bash", tool_input: { command: "true" } }),
    ).resolves.toMatchObject({ exitCode: 0 });

    const permission = await invoke("permission_request", {
      agent_id: "child-thread",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "true" },
    });
    expect(JSON.parse(permission.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(approvalRequester).toHaveBeenCalledOnce();

    await expect(
      invoke("post_tool_use", {
        agent_id: "child-thread",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "true" },
        tool_response: { output: "ok" },
        tool_use_id: "child-post-tool",
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(afterToolCall).toHaveBeenCalledOnce();

    expect(closeAdmittedRunDelegatedAuthority(admittedRunContext)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(delegatedAuthority)).toBe(false);
    await expect(
      mintAgentRuntimeIdentityToken({
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: admittedRunContext.operationalRunInstance,
      }),
    ).rejects.toThrow("requires active delegated run authority");
    expect(
      createAgentRuntimeApprovalAuthorityValidator()({
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        delegatedAuthority: { kind: "local", ...delegatedAuthority },
      }),
    ).toBe(false);
    relay.unregister();
    await expect(
      invoke("pre_tool_use", {
        agent_id: "child-thread",
        tool_name: "Bash",
        tool_input: { command: "true" },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      invoke("permission_request", {
        agent_id: "child-thread",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "true" },
      }),
    ).rejects.toThrow("foreground invocation not allowed");
    await expect(
      invoke("post_tool_use", {
        agent_id: "child-thread",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "true" },
        tool_response: { output: "ok" },
        tool_use_id: "child-post-tool-after-close",
      }),
    ).rejects.toThrow("foreground invocation not allowed");
    await expect(
      invoke("pre_tool_use", {
        agent_id: "unknown-child",
        tool_name: "Bash",
        tool_input: { command: "true" },
      }),
    ).rejects.toThrow("retained invocation not allowed");
    await expect(
      invoke("pre_tool_use", {
        agent: { agent_id: "child-thread" },
        tool_name: "Bash",
        tool_input: { command: "true" },
      }),
    ).rejects.toThrow("foreground invocation not allowed");

    expect(admitExecution).toHaveBeenCalledTimes(2);
    const [invocation, retainedGuard, preparation] = admitExecution.mock.lastCall ?? [];
    expect(invocation).toMatchObject({ rawPayload: { agent_id: "child-thread" } });
    expect(retainedGuard).toBeTypeOf("function");
    expect(preparation).toMatchObject({ assertCurrent: expect.any(Function) });
    retainChild = false;
    relay.unregister();
  });

  it.each(["abort", "expiry"] as const)(
    "physically releases active retained child authority on %s",
    async (cause) => {
      if (cause === "expiry") {
        vi.useFakeTimers();
      }
      const { admittedRunContext, hostCapabilities } =
        await createAdmittedHostCapabilityTestFixture({ runId: `run-retained-${cause}` });
      const delegatedAuthority = getAdmittedRunDelegatedAuthority(admittedRunContext);
      if (!delegatedAuthority) {
        throw new Error("Expected admitted delegated authority");
      }
      const controller = new AbortController();
      const relay = registerOwnedRelay({
        relayId: uniqueNativeHookRelayIdForTests(`retained-${cause}`),
        runId: `run-retained-${cause}`,
        allowedEvents: ["pre_tool_use"],
        runBeforeToolCall: hostCapabilities.runBeforeToolCall,
        assertActive: hostCapabilities.assertActive,
        retention: {
          readClaim: readTestNativeAgentId,
          shouldRetainAfterForegroundClose: () => true,
          allowPreToolUse: (claim) => claim === "child-thread",
          onDispose: () => {},
        },
        ...(cause === "abort" ? { signal: controller.signal } : { ttlMs: 5 }),
      });

      closeAdmittedRunDelegatedAuthority(admittedRunContext);
      expect(validateAgentRunDelegatedAuthority(delegatedAuthority)).toBe(false);
      relay.unregister();
      await expect(
        invokeRelay(relay.relayId, "pre_tool_use", {
          agent_id: "child-thread",
          tool_name: "Bash",
          tool_input: {},
        }),
      ).resolves.toMatchObject({ exitCode: 0 });

      if (cause === "abort") {
        controller.abort();
      } else {
        await vi.advanceTimersByTimeAsync(6);
      }
      expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
      expect(await testing.getNativeHookRelayBridgeRecordForTests(relay.relayId)).toBeUndefined();
      await expect(
        invokeRelay(relay.relayId, "pre_tool_use", {
          agent_id: "child-thread",
          tool_name: "Bash",
          tool_input: {},
        }),
      ).rejects.toThrow("native hook relay not found");
    },
  );

  it("leaves retained host authority available after an ordinary same-host relay", async () => {
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId: "run-ordinary-then-retaining",
    });
    const ordinary = registerRelay({
      relayId: uniqueNativeHookRelayIdForTests("ordinary-same-host"),
      runId: "run-ordinary",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
    });
    const retaining = registerOwnedRelay({
      relayId: uniqueNativeHookRelayIdForTests("retaining-same-host"),
      runId: "run-retaining",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => true,
        allowPreToolUse: (claim) => claim === "child-thread",
        onDispose: () => {},
      },
    });

    closeAdmittedRunDelegatedAuthority(admittedRunContext);
    ordinary.unregister();
    retaining.unregister();
    await expect(
      invokeRelay(retaining.relayId, "pre_tool_use", {
        agent_id: "child-thread",
        tool_name: "Bash",
        tool_input: {},
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    retaining.unregister();
  });

  it("does not retain authority from a runtime-shaped public registration", async () => {
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId: "run-forged-public-retention",
    });
    const onDispose = vi.fn();
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: uniqueNativeHookRelayIdForTests("forged-public-retention"),
      sessionId: "session-1",
      runId: "run-forged-public-retention",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => true,
        allowPreToolUse: () => true,
        onDispose,
      },
    } as unknown as Parameters<typeof registerNativeHookRelay>[0]);

    expect(closeAdmittedRunDelegatedAuthority(admittedRunContext)).toBe(true);
    relay.unregister();

    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
    expect(onDispose).not.toHaveBeenCalled();
    await expect(
      invokeRelay(relay.relayId, "pre_tool_use", {
        agent_id: "child-thread",
        tool_name: "Bash",
        tool_input: {},
      }),
    ).rejects.toThrow("native hook relay not found");
  });

  it("fails closed when a retained relay predicate throws", async () => {
    const host = await createAdmittedHostCapabilityTestFixture({
      runId: "run-throwing-retain-predicate",
    });
    const shouldRetainAfterForegroundClose = vi.fn(() => {
      throw new Error("predicate failed");
    });
    try {
      const relay = registerOwnedRelay({
        relayId: uniqueNativeHookRelayIdForTests("throwing-retain-predicate"),
        runId: "run-throwing-retain-predicate",
        allowedEvents: ["pre_tool_use"],
        runBeforeToolCall: host.hostCapabilities.runBeforeToolCall,
        assertActive: host.hostCapabilities.assertActive,
        retention: {
          readClaim: readTestNativeAgentId,
          allowPreToolUse: () => true,
          onDispose: () => {},
          shouldRetainAfterForegroundClose,
        },
      });

      expect(() => relay.unregister()).not.toThrow();
      expect(shouldRetainAfterForegroundClose).toHaveBeenCalledOnce();
      expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
      await expect(
        invokeRelay(relay.relayId, "pre_tool_use", {
          agent_id: "child-thread",
          tool_name: "Bash",
          tool_input: {},
        }),
      ).rejects.toThrow("native hook relay not found");
    } finally {
      host.closeHost();
      host.closeAdmission();
    }
  });

  it("preserves the successor when its predecessor's disposal observer throws", () => {
    const relayId = uniqueNativeHookRelayIdForTests("throwing-unregister");
    const onDispose = vi.fn(() => {
      throw new Error("teardown observer failed");
    });
    registerOwnedRelay({
      runId: "run-first",
      relayId,
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => false,
        allowPreToolUse: () => false,
        onDispose,
      },
    });
    const successor = registerRelay({ relayId, runId: "run-successor" });
    expect(onDispose).toHaveBeenCalledOnce();
    expect(testing.getNativeHookRelayRegistrationForTests(relayId)?.runId).toBe(successor.runId);
  });

  it("keeps the callback-created successor after replacement teardown", async () => {
    const relayId = uniqueNativeHookRelayIdForTests("replacement-reentrant-successor");
    let callbackSuccessor: ReturnType<typeof registerNativeHookRelay> | undefined;
    const first = registerOwnedRelay({
      relayId,
      runId: "run-first",
      allowedEvents: ["post_tool_use"],
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => false,
        allowPreToolUse: () => false,
        onDispose: () => {
          callbackSuccessor = registerNativeHookRelay({
            provider: "codex",
            relayId,
            sessionId: "session-1",
            runId: "run-callback-successor",
            allowedEvents: ["post_tool_use"],
          });
        },
      },
    });
    const replacementUnregistered = vi.fn();
    registerOwnedRelay({
      relayId,
      runId: "run-replacement",
      allowedEvents: ["post_tool_use"],
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => false,
        allowPreToolUse: () => false,
        onDispose: replacementUnregistered,
      },
    });

    expect(callbackSuccessor).toBeDefined();
    expect(replacementUnregistered).toHaveBeenCalledOnce();
    expect(testing.getNativeHookRelayRegistrationForTests(relayId)?.runId).toBe(
      "run-callback-successor",
    );
    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId,
        generation: callbackSuccessor!.generation,
        event: "post_tool_use",
        timeoutMs: 2_000,
        rawPayload: { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: {} },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    first.unregister();
    callbackSuccessor?.unregister();
  });

  it("delivers old replacement callback when the successor signal is already aborted", async () => {
    const relayId = uniqueNativeHookRelayIdForTests("replacement-preaborted");
    const oldUnregistered = vi.fn();
    registerOwnedRelay({
      relayId,
      runId: "run-old",
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => false,
        allowPreToolUse: () => false,
        onDispose: oldUnregistered,
      },
    });
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      registerRelay({ relayId, runId: "run-preaborted-successor", signal: controller.signal }),
    ).toThrow("native hook relay registration aborted");

    expect(oldUnregistered).toHaveBeenCalledOnce();
    expect(testing.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
    expect(await testing.getNativeHookRelayBridgeRecordForTests(relayId)).toBeUndefined();
  });

  it("cleans a partial retained relay when bridge setup throws", async () => {
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId: "run-bridge-setup-throws",
    });
    const relayId = uniqueNativeHookRelayIdForTests("bridge-setup-throws");
    const bridgeFailure = vi
      .spyOn(nativeHookRelayBridge, "registerNativeHookRelayBridge")
      .mockImplementation(() => {
        throw new Error("bridge setup failed");
      });

    expect(() =>
      registerOwnedRelay({
        relayId,
        runId: "run-bridge-setup-throws",
        runBeforeToolCall: hostCapabilities.runBeforeToolCall,
        assertActive: hostCapabilities.assertActive,
        retention: {
          readClaim: readTestNativeAgentId,
          shouldRetainAfterForegroundClose: () => true,
          allowPreToolUse: () => false,
          onDispose: () => {},
        },
      }),
    ).toThrow("bridge setup failed");
    expect(testing.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
    expect(await testing.getNativeHookRelayBridgeRecordForTests(relayId)).toBeUndefined();
    expect(getAdmittedRunDelegatedAuthority(admittedRunContext)).toBeDefined();

    bridgeFailure.mockRestore();
    const successor = registerRelay({ relayId, runId: "run-bridge-setup-successor" });
    expect(testing.getNativeHookRelayRegistrationForTests(relayId)?.runId).toBe(
      "run-bridge-setup-successor",
    );
    successor.unregister();
  });

  it("does not remember allow-always approvals when expiry would exceed Date range", async () => {
    const relay = registerRelay({ relayId: "codex-permission-overflow-session" });
    const approvalRequester = vi.fn(async () => "allow-always" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const state = getNativeHookRelaySharedStateForTests();
    const registration = state.relays.get(relay.relayId) as { expiresAtMs?: number } | undefined;
    if (!registration) {
      throw new Error("Expected native hook relay registration");
    }
    registration.expiresAtMs = 8_640_000_000_000_000;

    await expect(
      invokeRelay(relay.relayId, "permission_request", {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "git status" },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(state.permissionAllowAlwaysApprovals.size).toBe(0);

    await expect(
      invokeRelay(relay.relayId, "permission_request", {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-2",
        tool_input: { command: "git status" },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(approvalRequester).toHaveBeenCalledTimes(2);
  });

  it("shares relay state across duplicate module instances", async () => {
    const duplicateModule = await importDuplicateNativeHookRelayModuleForTests();
    const relay = registerOwnedRelay({
      relayId: "codex-duplicate-module-session",
      allowedEvents: ["pre_tool_use", "permission_request"],
    });
    await relay.ready;

    await expect(
      duplicateModule.invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(getOnlyNativeHookRelayInvocation()).toMatchObject({
      relayId: relay.relayId,
      event: "pre_tool_use",
    });

    const duplicateApprovalRequester = vi.fn(async () => "allow-always" as const);
    duplicateModule.testing.setNativeHookRelayPermissionApprovalRequesterForTests(
      duplicateApprovalRequester,
    );
    const duplicateApproval = await duplicateModule.invokeNativeHookRelay(
      createPermissionRequestFixture(relay.relayId, "native-call-1", {
        command: "git status",
        environment: { first: 1, second: 2 },
      }),
    );
    expect(JSON.parse(duplicateApproval.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });

    const primaryApprovalRequester = vi.fn(async () => "deny" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(primaryApprovalRequester);
    const primaryApproval = await invokeNativeHookRelay(
      createPermissionRequestFixture(relay.relayId, "native-call-2", {
        environment: { second: 2, first: 1 },
        command: "git status",
      }),
    );
    expect(JSON.parse(primaryApproval.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });

    expect(duplicateApprovalRequester).toHaveBeenCalledTimes(1);
    expect(primaryApprovalRequester).not.toHaveBeenCalled();

    const replacement = duplicateModule.registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });
    await replacement.ready;
    expect(replacement.relayId).toBe(relay.relayId);
    const replacementExpiry = testing.getNativeHookRelayRegistrationForTests(
      relay.relayId,
    )?.expiresAtMs;
    relay.renew(60_000);
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)?.expiresAtMs).toBe(
      replacementExpiry,
    );
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toMatchObject({
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });

    relay.unregister();
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toMatchObject({
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });
    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: replacement.relayId,
        generation: replacement.generation,
        event: "post_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_use_id: "replacement-call",
          tool_input: { command: "pnpm test" },
          tool_response: { output: "ok", exit_code: 0 },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(testing.getNativeHookRelayInvocationsForTests()).toContainEqual(
      expect.objectContaining({ relayId: replacement.relayId, toolUseId: "replacement-call" }),
    );
    replacement.unregister();
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
  });

  it("invokes the successor when retirement expires before its listener publishes", async () => {
    const first = registerOwnedRelay({
      relayId: uniqueNativeHookRelayIdForTests("replacement-publication"),
      runId: "run-first",
      allowedEvents: ["post_tool_use"],
    });
    await waitForNativeHookRelayBridgeRecord(first.relayId);
    const connectionErrors: unknown[] = [];
    // oxlint-disable-next-line typescript/unbound-method -- called below with the intercepted socket receiver.
    const originalEmit = Socket.prototype.emit;
    vi.spyOn(Socket.prototype, "emit").mockImplementation(function (this: Socket, event, ...args) {
      if (event === "error") {
        connectionErrors.push(args[0]);
      }
      return originalEmit.call(this, event, ...args);
    });
    const remove = nativeHookRelayStore.deleteNativeHookRelayBridgeRecordIfOwned;
    const removed = createDeferredCore();
    vi.spyOn(nativeHookRelayStore, "deleteNativeHookRelayBridgeRecordIfOwned").mockImplementation(
      async (params) => {
        const result = await remove(params);
        removed.resolve();
        return result;
      },
    );
    // oxlint-disable-next-line typescript/unbound-method -- replayed with the captured server receiver.
    const originalListen = Server.prototype.listen;
    let startSuccessor: (() => void) | undefined;
    const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(function (
      this: Server,
      ...args
    ) {
      startSuccessor = () => {
        Reflect.apply(originalListen, this, args);
      };
      return this;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const successor = registerRelay({
        relayId: first.relayId,
        runId: "run-successor",
        allowedEvents: ["post_tool_use"],
      });
      // The grace begins after durable removal, while successor publication is held explicitly.
      await removed.promise;
      await vi.advanceTimersByTimeAsync(250);
      await first.drain();
      vi.useRealTimers();
      const result = expect(
        invokeNativeHookRelayBridge({
          provider: "codex",
          relayId: successor.relayId,
          generation: successor.generation,
          event: "post_tool_use",
          timeoutMs: 2_000,
          rawPayload: { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: {} },
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(startSuccessor).toBeTypeOf("function");
      startSuccessor?.();
      await result;
      expect(connectionErrors).toEqual([]);
      expect(getOnlyNativeHookRelayInvocation()).toMatchObject({ runId: "run-successor" });
    } finally {
      listen.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    { event: "pre_tool_use", noop: false },
    { event: "pre_tool_use", noop: true },
    { event: "permission_request", noop: false },
    { event: "post_tool_use", noop: false },
  ] as const)(
    "keeps stale CLI authority closed during delayed publication ($event, noop=$noop)",
    async ({ event, noop }) => {
      const first = registerRelay({
        relayId: uniqueNativeHookRelayIdForTests("replacement-cli"),
        runId: "run-first",
        allowedEvents: [event],
      });
      await waitForNativeHookRelayBridgeRecord(first.relayId);
      const command = buildNativeHookRelayCommand({
        provider: "codex",
        relayId: first.relayId,
        generation: first.generation,
        event,
        ...(noop ? { preToolUseUnavailable: "noop" } : {}),
        timeoutMs: 2_000,
      });
      const argv = splitShellArgs(command);
      if (!argv) {
        throw new Error("Expected generated relay command to parse");
      }
      // Hold successor startup, while keeping the retired listener and real
      // read-only locator lookup intact across the CLI registration deadline.
      const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(function (
        this: Server,
      ) {
        return this;
      });
      try {
        registerRelay({ relayId: first.relayId, runId: "run-successor", allowedEvents: [event] });
        const callGateway = vi.fn(async (opts: { params?: unknown }): Promise<never> => {
          let failure = "Gateway unexpectedly accepted the retired generation";
          await nativeHookRelayHandlers["nativeHook.invoke"]!({
            req: { type: "req", id: "replacement-cli", method: "nativeHook.invoke" },
            params: requireRecord(opts.params, "gateway relay parameters"),
            client: null,
            isWebchatConnect: () => false,
            respond: (ok, _result, error) => {
              expect(ok).toBe(false);
              failure = error?.message ?? failure;
            },
            context: {} as never,
          });
          throw new Error(failure);
        });
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        await expect(
          runNativeHookRelayCliFromArgvForTest(argv, {
            stdin: Readable.from([
              JSON.stringify({
                hook_event_name: "PreToolUse",
                tool_name: "Bash",
                tool_input: { command: "echo fixture" },
              }),
            ]),
            stdout,
            stderr,
            callGateway,
          }),
        ).resolves.toBe(0);
        expect(callGateway).toHaveBeenCalledOnce();
        expect(String(stderr.read())).toContain("native hook relay bridge stale registration");
        const output = String(stdout.read() ?? "");
        if (event === "pre_tool_use" && !noop) {
          expect(JSON.parse(output).hookSpecificOutput.permissionDecision).toBe("deny");
        } else if (event === "permission_request") {
          expect(JSON.parse(output).hookSpecificOutput.decision.behavior).toBe("deny");
        } else {
          expect(output).toBe("");
        }
        expect(testing.getNativeHookRelayInvocationsForTests()).toEqual([]);
      } finally {
        listen.mockRestore();
      }
    },
  );

  it("unions hook and trusted-policy matcher scopes for pre-tool relays", () => {
    const hookRegistry = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: vi.fn(), matcher: ["exec"] },
    ]);
    const policyRegistry = createMockPluginRegistry([]);
    policyRegistry.trustedToolPolicies = [
      {
        pluginId: "policy-plugin",
        pluginName: "Policy Plugin",
        source: "test",
        policy: {
          id: "patch-policy",
          description: "Protect patch tools",
          matcher: ["apply_patch"],
          evaluate: vi.fn(),
        },
      },
    ];
    setActivePluginRegistry(policyRegistry);
    initializeGlobalHookRunner(hookRegistry);

    const relay = registerRelay({
      preToolUseLoopDetection: false,
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);
    expect(relay.toolMatcherForEvent("pre_tool_use")).toEqual(["apply_patch", "exec"]);
  });

  it("rejects a retired direct bridge with an already connected request", async () => {
    const first = registerRelay({ allowedEvents: ["pre_tool_use"] });
    const firstRecord = await waitForNativeHookRelayBridgeRecord(first.relayId);
    const payload = {
      provider: "codex",
      relayId: first.relayId,
      generation: first.generation,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      },
    };
    const pending = openDeferredNativeHookRelayBridgeRequest(firstRecord, payload);
    await pending.connected;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    const second = registerRelay({
      relayId: first.relayId,
      runId: "run-2",
      allowedEvents: ["pre_tool_use"],
    });
    const response = Promise.all([pending.connected, pending.response]);
    pending.sendBody();
    await expect(response).resolves.toEqual([
      undefined,
      { ok: false, error: "native hook relay bridge stale registration" },
    ]);
    expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
    await expect(
      invokeNativeHookRelayBridge({
        ...payload,
        generation: second.generation,
        timeoutMs: 2_000,
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  it.each(["replacement", "bootstrap grace", "expired grace"] as const)(
    "enforces direct bridge generation authority for %s",
    async (mode) => {
      const first = registerRelay({
        allowedEvents: ["pre_tool_use"],
        ...(mode === "bootstrap grace" ? { generationMismatchGraceMs: 60_000 } : {}),
        ...(mode === "expired grace" ? { generationMismatchGraceMs: 1 } : {}),
      });
      let current = first;
      if (mode === "replacement") {
        const command = first.commandForEvent("pre_tool_use");
        expect(command).toContain("--generation");
        expect(command).toContain(first.generation);
        await waitForNativeHookRelayBridgeRecord(first.relayId);
        current = registerRelay({
          relayId: first.relayId,
          runId: "run-2",
          allowedEvents: ["pre_tool_use"],
        });
      } else if (mode === "expired grace") {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      const invokeGeneration = (generation: string) =>
        invokeNativeHookRelayBridge({
          provider: "codex",
          relayId: first.relayId,
          generation,
          event: "pre_tool_use",
          timeoutMs: 2_000,
          rawPayload: {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "pnpm test" },
          },
        });
      const generation =
        mode === "replacement" ? first.generation : "stale-generation-from-resumed-thread";
      if (mode === "bootstrap grace") {
        await expect(invokeGeneration(generation)).resolves.toEqual({
          stdout: "",
          stderr: "",
          exitCode: 0,
        });
        expect(getOnlyNativeHookRelayInvocation()).toMatchObject({
          relayId: first.relayId,
          runId: "run-1",
          event: "pre_tool_use",
        });
        await expect(invokeGeneration("different-stale-generation")).rejects.toThrow(
          "native hook relay bridge stale registration",
        );
      } else {
        await expect(invokeGeneration(generation)).rejects.toThrow(
          "native hook relay bridge stale registration",
        );
        expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
        if (mode === "replacement") {
          await expect(invokeGeneration(current.generation)).resolves.toEqual({
            stdout: "",
            stderr: "",
            exitCode: 0,
          });
          expect(getOnlyNativeHookRelayInvocation()).toMatchObject({
            relayId: current.relayId,
            runId: "run-2",
            event: "pre_tool_use",
          });
        }
      }
    },
  );

  it("prunes expired and dead foreign records while preserving live and protected owners", async () => {
    const records = [
      { pid: 9_999_991, state: "dead", expired: false },
      { pid: 9_999_992, state: "expired", expired: true },
      { pid: 9_999_994, state: "live", expired: false },
      { pid: 9_999_995, state: "protected", expired: false },
    ];
    const relayIds = await Promise.all(
      records.map(({ pid, state, expired }) =>
        writeForeignNativeHookRelayBridgeRecordForTests(
          uniqueNativeHookRelayIdForTests(`codex-foreign-${state}`),
          { pid, expiresAtMs: Date.now() + (expired ? -1 : 60_000) },
        ),
      ),
    );
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 9_999_995) {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }
      if (pid !== 9_999_992 && pid !== 9_999_994) {
        throw Object.assign(new Error("missing process"), { code: "ESRCH" });
      }
      return true;
    });
    const relay = registerOwnedRelay({ allowedEvents: ["pre_tool_use"] });
    await relay.ready;
    for (const [index, { pid, state }] of records.entries()) {
      if (state === "expired") {
        expect(kill).not.toHaveBeenCalledWith(pid, 0);
      } else {
        expect(kill).toHaveBeenCalledWith(pid, 0);
      }
      const record = await testing.getNativeHookRelayBridgeRecordForTests(relayIds[index]!);
      if (state === "dead" || state === "expired") {
        expect(record).toBeUndefined();
      } else {
        expect(record).toBeDefined();
      }
    }
  });

  it("treats direct bridge records with a dead owning pid as absent", async () => {
    const relayId = await writeForeignNativeHookRelayBridgeRecordForTests(
      uniqueNativeHookRelayIdForTests("codex-dead-pid-bridge"),
      {
        pid: 9_999_996,
        expiresAtMs: Date.now() + 60_000,
      },
    );
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 9_999_996) {
        throw Object.assign(new Error("missing process"), { code: "ESRCH" });
      }
      return true;
    });

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId,
        event: "pre_tool_use",
        registrationTimeoutMs: 1,
        timeoutMs: 50,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay bridge not found");
    expect(kill).toHaveBeenCalledWith(9_999_996, 0);
  });

  it("accepts only loopback direct bridge records", async () => {
    const relay = registerRelay({
      relayId: "codex-private-bridge-session",
      allowedEvents: ["pre_tool_use"],
    });

    const record = await waitForNativeHookRelayBridgeRecord(relay.relayId);
    await nativeHookRelayStore.writeNativeHookRelayBridgeRecord({
      // Simulate a hostile/corrupt database row outside the typed store contract.
      record: {
        ...record,
        hostname: "192.0.2.1",
        expiresAtMs: Date.now() + 10_000,
      } as unknown as NativeHookRelayBridgeRecord,
    });

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: relay.relayId,
        generation: relay.generation,
        event: "pre_tool_use",
        registrationTimeoutMs: 1,
        timeoutMs: 50,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay bridge not found");
  });

  it("reports whether a relay already observed a tool use invocation", async () => {
    const relay = registerRelay({
      allowedEvents: ["pre_tool_use", "post_tool_use"],
    });

    expect(
      hasNativeHookRelayInvocation({
        relayId: relay.relayId,
        event: "pre_tool_use",
        toolUseId: "call-1",
      }),
    ).toBe(false);

    await invokeRelay(relay.relayId, "pre_tool_use", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "call-1",
      tool_input: { command: "pnpm test" },
    });

    expect(
      hasNativeHookRelayInvocation({
        relayId: relay.relayId,
        event: "pre_tool_use",
        toolUseId: "call-1",
      }),
    ).toBe(true);
    expect(
      hasNativeHookRelayInvocation({
        relayId: relay.relayId,
        event: "post_tool_use",
        toolUseId: "call-1",
      }),
    ).toBe(false);
    expect(
      hasNativeHookRelayInvocation({
        relayId: relay.relayId,
        event: "pre_tool_use",
      }),
    ).toBe(false);
  });

  it("bounds retained invocation history and truncates payloads at UTF-16 boundaries", async () => {
    const relay = registerRelay({ allowedEvents: ["post_tool_use"] });
    for (let index = 0; index < 210; index += 1) {
      await invokeRelay(relay.relayId, "post_tool_use", {
        tool_use_id: `call-${index}`,
        tool_response: index === 209 ? `${"a".repeat(3_999)}😀tail` : `output-${index}`,
      });
    }
    const invocations = testing.getNativeHookRelayInvocationsForTests();
    expect(invocations).toHaveLength(200);
    expect(invocations.map((invocation) => invocation.toolUseId)).not.toContain("call-0");
    expect(invocations.at(-1)?.toolUseId).toBe("call-209");
    const payload = readRecordField(
      requireRecord(invocations.at(-1), "native hook relay invocation"),
      "rawPayload",
      "invocation raw payload",
    );
    expect(payload.tool_response).toBe(`${"a".repeat(3_999)}...[truncated]`);
  });

  it("rejects missing, wrong-provider, and disallowed-event invocations", async () => {
    await expect(invokeRelay("missing", "pre_tool_use", {})).rejects.toThrow("not found");

    const relay = registerRelay({
      allowedEvents: ["post_tool_use"],
    });

    await expect(
      invokeNativeHookRelay({
        provider: "claude-code",
        relayId: relay.relayId,
        event: "post_tool_use",
        rawPayload: {},
      }),
    ).rejects.toThrow("unsupported");

    await expect(invokeRelay(relay.relayId, "pre_tool_use", {})).rejects.toThrow("not allowed");
  });

  it.each([
    {
      budget: "depth",
      event: "pre_tool_use",
      payload: () => {
        let value: Record<string, unknown> = {};
        for (let index = 0; index < 80; index += 1) {
          value = { child: value };
        }
        return value;
      },
    },
    {
      budget: "nodes before reading excess children",
      event: "post_tool_use",
      payload: (readChild: () => string) => {
        const value = Object.fromEntries(
          Array.from({ length: 19_999 }, (_, index) => [`k${index}`, index]),
        );
        Object.defineProperty(value, "overBudget", { enumerable: true, get: readChild });
        return value;
      },
    },
    {
      budget: "string length",
      event: "post_tool_use",
      payload: () => ({ tool_response: "x".repeat(1_000_001) }),
    },
    {
      budget: "aggregate strings",
      event: "post_tool_use",
      payload: () => Array.from({ length: 5 }, () => "x".repeat(900_000)),
    },
    {
      budget: "object key length",
      event: "permission_request",
      payload: () => ({
        hook_event_name: "PermissionRequest",
        tool_name: "mcp__shell__run_command",
        tool_input: { ["x".repeat(1_000_001)]: "value" },
      }),
    },
  ] as const)("rejects payloads beyond the relay $budget budget", async ({ event, payload }) => {
    const relay = registerRelay({ allowedEvents: [event] });
    const readChild = vi.fn(() => "should not be read");
    await expect(invokeRelay(relay.relayId, event, payload(readChild))).rejects.toThrow(
      "JSON-compatible",
    );
    expect(readChild).not.toHaveBeenCalled();
  });

  it("rejects expired relay ids", async () => {
    const relay = registerRelay({
      ttlMs: 5_000,
    });
    await waitForNativeHookRelayBridgeRecord(relay.relayId);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(relay.expiresAtMs + 1));

    await expect(invokeRelay(relay.relayId, "pre_tool_use", {})).rejects.toThrow("expired");
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
    expect(await testing.getNativeHookRelayBridgeRecordForTests(relay.relayId)).toBeUndefined();
    relay.unregister();
    expect(await testing.getNativeHookRelayBridgeRecordForTests(relay.relayId)).toBeUndefined();
  });

  it("uses the Codex no-op output when no OpenClaw hook decides", async () => {
    const relay = registerRelay();

    for (const event of ["pre_tool_use", "post_tool_use", "before_agent_finalize"] as const) {
      await expect(invokeRelay(relay.relayId, event, { hook_event_name: event })).resolves.toEqual({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
    }
  });

  it("maps Codex PreToolUse to OpenClaw before_tool_call and blocks before execution", async () => {
    const beforeToolCall = vi.fn(async () => ({
      block: true,
      blockReason: "repo policy blocks this command",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: beforeToolCall, matcher: ["exec"] },
      ]),
    );
    const relay = registerAgentRelay({
      channelId: "telegram",
      requester: {
        channel: "telegram",
        accountId: "operations",
        senderId: "maintainer-user",
        senderIsOwner: false,
        roleIds: ["maintainer-role"],
      },
    });

    const response = await invokeRelay(relay.relayId, "pre_tool_use", {
      hook_event_name: "PreToolUse",
      cwd: "/repo",
      model: "gpt-5.4",
      tool_name: "Bash",
      tool_use_id: "native-call-1",
      tool_input: { command: "rm -rf dist" },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "repo policy blocks this command",
      },
    });
    expect(response.exitCode).toBe(0);
    const event = getMockCallArg(beforeToolCall, 0, 0, "before tool call event");
    expectRecordFields(event, {
      toolName: "exec",
      params: { command: "rm -rf dist" },
      runId: "run-1",
      toolCallId: "native-call-1",
    });
    const context = getMockCallArg(beforeToolCall, 0, 1, "before tool call context");
    expectRecordFields(context, {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      channelId: "telegram",
      requester: {
        channel: "telegram",
        accountId: "operations",
        senderId: "maintainer-user",
        senderIsOwner: false,
        roleIds: ["maintainer-role"],
      },
      toolName: "exec",
      toolCallId: "native-call-1",
    });
  });

  it.each(["timeout", "rejected projection"] as const)(
    "preserves native pre-tool failure ownership for %s",
    async (mode) => {
      const onPreToolUseFailure = vi.fn(async () => {
        if (mode === "rejected projection") {
          throw new Error("diagnostic sink unavailable");
        }
      });
      const beforeToolCall = vi.fn(async () => {
        throw mode === "rejected projection"
          ? new Error("hook crashed")
          : Object.assign(new Error("timed out after 5000ms"), { name: "TimeoutError" });
      });
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
      );
      const relay = registerRelay({
        ...(mode !== "rejected projection" ? { agentId: "agent-1" } : {}),
        onPreToolUseFailure,
      });
      const payload = {
        hook_event_name: "PreToolUse",
        ...(mode === "timeout" ? { cwd: "/repo" } : {}),
        tool_name: "exec_command",
        tool_use_id: "native-failure",
        tool_input: { cmd: "pnpm test" },
      };
      const response = await invokeRelay(relay.relayId, "pre_tool_use", payload);
      expect(response.failureDisposition).toBe(
        mode === "rejected projection" ? "failed" : "timed_out",
      );
      expect(onPreToolUseFailure).toHaveBeenCalledTimes(1);
      if (mode === "timeout") {
        expect(JSON.parse(response.stdout)).toMatchObject({
          hookSpecificOutput: { permissionDecision: "deny" },
        });
        expect(onPreToolUseFailure).toHaveBeenCalledWith({
          toolName: "exec",
          toolCallId: "native-failure",
          disposition: "timed_out",
          durationMs: expect.any(Number),
        });
        await invokeRelay(relay.relayId, "pre_tool_use", {
          hook_event_name: "PreToolUse",
          tool_name: "exec_command",
          tool_use_id: "native-failure",
          tool_input: { cmd: "pnpm test" },
        });
        expect(onPreToolUseFailure).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([
    {
      kind: "stale command",
      nativeToolName: "exec_command",
      toolName: "exec",
      input: { command: "echo safe", cmd: "rm -rf dist", yield_time_ms: 1000 },
      params: { command: "rm -rf dist", cmd: "rm -rf dist", yield_time_ms: 1000 },
      reason: "destructive command blocked",
    },
    {
      kind: "argv command",
      nativeToolName: "exec_command",
      toolName: "exec",
      input: { cmd: ["cat", "/tmp/private key"] },
      params: { cmd: ["cat", "/tmp/private key"], command: "cat '/tmp/private key'" },
      reason: "argv command blocked",
    },
    {
      kind: "Write alias",
      nativeToolName: "Write",
      toolName: "apply_patch",
      input: { patch: "*** Begin Patch" },
      params: { patch: "*** Begin Patch" },
      reason: "tool blocked",
    },
  ])(
    "applies canonical policy to Codex $kind",
    async ({ kind, nativeToolName, toolName, input, params, reason }) => {
      const alias = nativeToolName !== "exec_command";
      const beforeToolCall = vi.fn(async (event: unknown) => {
        const command = requireRecord(
          requireRecord(event, "before tool call event").params,
          "before tool call params",
        ).command;
        return kind !== "stale command" || command === params.command
          ? { block: true, blockReason: reason }
          : undefined;
      });
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_tool_call",
            handler: beforeToolCall,
            ...(kind !== "argv command" ? { matcher: [toolName] } : {}),
          },
        ]),
      );
      const relay = alias
        ? registerRelay({ preToolUseLoopDetection: false })
        : registerAgentRelay(kind === "stale command" ? { channelId: "telegram" } : {});
      if (alias) {
        expect(relay.toolMatcherForEvent("pre_tool_use")).toEqual([toolName]);
      }
      const response = await invokeRelay(relay.relayId, "pre_tool_use", {
        hook_event_name: "PreToolUse",
        ...(kind === "argv command" ? { cwd: "/repo" } : {}),
        tool_name: nativeToolName,
        tool_use_id: "native-canonical-tool",
        tool_input: input,
      });
      expect(JSON.parse(response.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      });
      expectRecordFields(getMockCallArg(beforeToolCall, 0, 0, "before tool call event"), {
        toolName,
        params,
        runId: "run-1",
        toolCallId: "native-canonical-tool",
      });
      expect(beforeToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ toolName }),
        expect.objectContaining({ toolName }),
      );
    },
  );

  it.each(["report rewrite", "in-place mutation"] as const)(
    "blocks Codex native pre-tool execution after a policy %s",
    async (mode) => {
      const beforeToolCall = vi.fn(async (event: unknown) => {
        if (mode === "report rewrite") {
          return { params: { command: "echo rewritten" } };
        }
        const params = requireRecord(
          requireRecord(event, "before tool call event").params,
          "before tool call params",
        );
        params.command = "echo rewritten";
        return { params };
      });
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
      );
      const relay = registerAgentRelay();
      const response = await invokeRelay(relay.relayId, "pre_tool_use", {
        hook_event_name: "PreToolUse",
        ...(mode === "report rewrite" ? { openclaw_approval_mode: "report" } : {}),
        cwd: "/repo",
        tool_name: "exec_command",
        tool_use_id: "native-policy-rewrite",
        tool_input: { cmd: "cat /tmp/private_key" },
      });
      expect(JSON.parse(response.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
        },
      });
      expect(beforeToolCall).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["allow once", "cancelled"] as const)(
    "settles deferred native approval as %s",
    async (resolution) => {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_tool_call",
            handler: vi.fn(async () => ({
              requireApproval: {
                title: "Needs approval",
                description: "native command needs approval",
              },
            })),
          },
        ]),
      );
      const relay =
        resolution === "allow once" ? registerAgentRelay() : registerRelay({ agentId: "agent-1" });
      const command = resolution === "allow once" ? "cat /tmp/private_key" : "pnpm test";
      const toolUseId = "native-approval-report";
      await invokeRelay(relay.relayId, "pre_tool_use", {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        cwd: "/repo",
        tool_name: "exec_command",
        tool_use_id: toolUseId,
        tool_input: { cmd: command },
      });
      const pending =
        createDeferredCore<
          Awaited<
            ReturnType<
              Parameters<typeof testing.setNativeHookRelayDeferredToolApprovalRequesterForTests>[0]
            >
          >
        >();
      const approvalRequester = vi.fn(() => pending.promise);
      testing.setNativeHookRelayDeferredToolApprovalRequesterForTests(approvalRequester);
      const request = { relayId: relay.relayId, toolUseId };
      const approval = resolveNativeHookRelayDeferredToolApproval(request);
      if (resolution === "allow once") {
        const duplicate = resolveNativeHookRelayDeferredToolApproval(request);
        await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(1));
        pending.resolve({
          blocked: false,
          params: { cmd: command, command },
          approvalResolution: "allow-once",
        });
        await expect(Promise.all([approval, duplicate])).resolves.toEqual([
          { handled: true, outcome: "approved-once" },
          { handled: true, outcome: "approved-once" },
        ]);
        await expect(resolveNativeHookRelayDeferredToolApproval(request)).resolves.toBeUndefined();
      } else {
        pending.resolve({
          blocked: true,
          kind: "failure",
          disposition: "cancelled",
          deniedReason: "plugin-approval",
          reason: "Approval cancelled because the run stopped",
        });
        await expect(approval).resolves.toEqual({
          handled: true,
          outcome: "denied",
          reason: "Approval cancelled because the run stopped",
          failureDisposition: "cancelled",
        });
      }
    },
  );

  it("passes config to trusted policies for native pre-tool session extension reads", async () => {
    const stateDir = sessionDirs.make();
    const storePath = path.join(stateDir, "sessions.json");
    const config = { session: { store: storePath } };
    const seen: unknown[] = [];
    const registry = createEmptyPluginRegistry();
    registry.sessionExtensions = [
      {
        pluginId: "policy-plugin",
        pluginName: "Policy Plugin",
        source: "test",
        extension: {
          namespace: "policy",
          description: "policy state",
        },
      },
    ];
    registry.trustedToolPolicies = [
      {
        pluginId: "policy-plugin",
        pluginName: "Policy Plugin",
        source: "test",
        policy: {
          id: "session-extension-policy",
          description: "session extension policy",
          evaluate(eventValue, ctx) {
            const policyState = ctx.getSessionExtension?.("policy");
            seen.push(policyState);
            if ((policyState as { block?: boolean } | undefined)?.block) {
              return { block: true, blockReason: "blocked by session extension" };
            }
            return undefined;
          },
        },
      },
    ];
    setActivePluginRegistry(registry);
    await replaceSessionEntry({ sessionKey: "agent:main:session-1", storePath }, {
      sessionId: "session-1",
      updatedAt: Date.now(),
    } as SessionEntry);
    const patchResult = await patchPluginSessionExtension({
      cfg: config as never,
      sessionKey: "agent:main:session-1",
      pluginId: "policy-plugin",
      namespace: "policy",
      value: { block: true },
    });
    expect(patchResult.ok).toBe(true);

    const relay = registerRelay({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      config: config as never,
      allowedEvents: ["pre_tool_use"],
      preToolUseLoopDetection: false,
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);

    const response = await invokeRelay(relay.relayId, "pre_tool_use", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "native-policy-call-1",
      tool_input: { command: "rm -rf dist" },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked by session extension",
      },
    });
    expect(seen).toEqual([{ block: true }]);
  });

  it("uses the Codex cwd when deriving apply_patch paths for PreToolUse", async () => {
    const beforeToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerAgentRelay();
    const cwd = path.join("/tmp", "openclaw-native-hook-cwd");
    const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+x", "*** End Patch"].join("\n");

    const response = await invokeRelay(relay.relayId, "pre_tool_use", {
      hook_event_name: "PreToolUse",
      cwd,
      tool_name: "apply_patch",
      tool_use_id: "native-patch-1",
      tool_input: { input: patch },
    });

    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    const event = getMockCallArg(beforeToolCall, 0, 0, "before tool call event");
    expectRecordFields(event, {
      toolName: "apply_patch",
      params: { input: patch },
      derivedPaths: [path.join(cwd, "src/new.ts")],
    });
    const context = getMockCallArg(beforeToolCall, 0, 1, "before tool call context");
    expectRecordFields(context, {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      toolName: "apply_patch",
      toolCallId: "native-patch-1",
    });
  });

  it("maps Codex PostToolUse to OpenClaw after_tool_call observation", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "after_tool_call", handler: afterToolCall, matcher: ["exec"] },
      ]),
    );
    const relay = registerAgentRelay({
      channelId: "telegram",
    });

    expect(relay.shouldRelayEvent("post_tool_use")).toBe(true);
    expect(relay.toolMatcherForEvent("post_tool_use")).toEqual(["exec"]);

    const response = await invokeRelay(relay.relayId, "post_tool_use", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "native-call-1",
      tool_input: { command: "pnpm test" },
      tool_response: { output: "ok", exit_code: 0 },
    });

    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    const event = getMockCallArg(afterToolCall, 0, 0, "after tool call event");
    expectRecordFields(event, {
      toolName: "exec",
      params: { command: "pnpm test" },
      runId: "run-1",
      toolCallId: "native-call-1",
      result: { output: "ok", exit_code: 0 },
    });
    const context = getMockCallArg(afterToolCall, 0, 1, "after tool call context");
    expectRecordFields(context, {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      channelId: "telegram",
      toolName: "exec",
      toolCallId: "native-call-1",
    });
  });

  it.each([
    { action: "revise", reason: "please run the focused tests before finalizing" },
    { action: "finalize", reason: "already checked" },
  ] as const)("maps Codex Stop to $action output", async ({ action, reason }) => {
    const beforeAgentFinalize = vi.fn(async () => ({ action, reason }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_finalize", handler: beforeAgentFinalize },
      ]),
    );
    const relay =
      action === "revise" ? registerAgentRelay({ channelId: "telegram" }) : registerRelay();

    expect(relay.shouldRelayEvent("before_agent_finalize")).toBe(true);

    const response = await invokeRelay(relay.relayId, "before_agent_finalize", {
      hook_event_name: "Stop",
      ...(action === "revise"
        ? {
            session_id: "codex-session-1",
            turn_id: "turn-1",
            cwd: "/repo",
            transcript_path: "/tmp/session.jsonl",
            model: "gpt-5.4",
            permission_mode: "workspace-write",
            stop_hook_active: true,
            last_assistant_message: "done",
          }
        : { stop_hook_active: false }),
    });

    expect(response).toEqual({
      stdout: `${JSON.stringify(action === "revise" ? { decision: "block", reason } : { continue: false, stopReason: reason })}\n`,
      stderr: "",
      exitCode: 0,
    });
    if (action !== "revise") {
      return;
    }
    const event = getMockCallArg(beforeAgentFinalize, 0, 0, "before finalize event");
    expectRecordFields(event, {
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      turnId: "turn-1",
      provider: "codex",
      model: "gpt-5.4",
      cwd: "/repo",
      transcriptPath: "/tmp/session.jsonl",
      stopHookActive: true,
      lastAssistantMessage: "done",
    });
    const context = getMockCallArg(beforeAgentFinalize, 0, 1, "before finalize context");
    expectRecordFields(context, {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      channelId: "telegram",
      workspaceDir: "/repo",
      modelId: "gpt-5.4",
    });
  });

  it("keeps allow-always PermissionRequest reuse scoped to matching cwd and input", async () => {
    const relay = registerRelay();
    const approvalRequester = vi.fn(async () => "allow-always" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    await invokeRelay(relay.relayId, "permission_request", {
      hook_event_name: "PermissionRequest",
      cwd: "/repo-a",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    await invokeRelay(relay.relayId, "permission_request", {
      hook_event_name: "PermissionRequest",
      cwd: "/repo-b",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    await invokeRelay(relay.relayId, "permission_request", {
      hook_event_name: "PermissionRequest",
      cwd: "/repo-a",
      tool_name: "Bash",
      tool_input: { command: "npm test -- --changed" },
    });

    expect(approvalRequester).toHaveBeenCalledTimes(3);
  });

  it("keeps replacement pending PermissionRequest approvals when stale approvals settle", async () => {
    const relayId = "codex-stale-pending-permission";
    const firstRelay = registerRelay({ relayId });
    const resolvers: Array<(decision: "allow") => void> = [];
    const approvalRequester = vi.fn(
      () =>
        new Promise<"allow">((resolve) => {
          resolvers.push(resolve);
        }),
    );
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);
    const payload = {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_use_id: "native-call-1",
      tool_input: { command: "git push" },
    };

    const firstApproval = invokeRelay(relayId, "permission_request", payload);
    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(1));
    expect(getNativeHookRelaySharedStateForTests().pendingPermissionApprovals.size).toBe(1);

    firstRelay.unregister();
    await expect(firstApproval).rejects.toThrow("registration is inactive");
    registerRelay({ relayId });
    const secondApproval = invokeRelay(relayId, "permission_request", payload);
    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(2));
    expect(getNativeHookRelaySharedStateForTests().pendingPermissionApprovals.size).toBe(1);

    resolvers[0]?.("allow");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(getNativeHookRelaySharedStateForTests().pendingPermissionApprovals.size).toBe(1);

    const duplicateSecondApproval = invokeRelay(relayId, "permission_request", payload);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(2));

    resolvers[1]?.("allow");
    await expect(Promise.all([secondApproval, duplicateSecondApproval])).resolves.toHaveLength(2);
    expect(getNativeHookRelaySharedStateForTests().pendingPermissionApprovals.size).toBe(0);
  });

  it("does not reuse pending PermissionRequest approvals when a tool call id is reused with different input", async () => {
    const relay = registerRelay();
    let resolveDecision: ((decision: "allow") => void) | undefined;
    const pendingDecision = new Promise<"allow">((resolve) => {
      resolveDecision = resolve;
    });
    const approvalRequester = vi.fn(async (request: { toolInput?: Record<string, unknown> }) => {
      return request.toolInput?.command === "git status" ? pendingDecision : "deny";
    });
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const first = invokeRelay(relay.relayId, "permission_request", {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_use_id: "reused-call-id",
      tool_input: { command: "git status" },
    });
    const second = invokeRelay(relay.relayId, "permission_request", {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_use_id: "reused-call-id",
      tool_input: { command: "rm -rf /tmp/openclaw-important-state" },
    });

    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(2));
    const secondResponse = await second;
    expect(JSON.parse(secondResponse.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Denied by user" },
      },
    });
    resolveDecision?.("allow");
    const firstResponse = await first;
    expect(JSON.parse(firstResponse.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("defers PermissionRequest approvals after the per-relay approval budget is exhausted", async () => {
    const relay = registerRelay();
    const approvalRequester = vi.fn(async () => "allow" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const responses = [];
    for (let index = 0; index < 13; index += 1) {
      responses.push(
        await invokeRelay(relay.relayId, "permission_request", {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_use_id: `native-call-${index}`,
          tool_input: { command: `echo ${index}` },
        }),
      );
    }

    expect(approvalRequester).toHaveBeenCalledTimes(12);
    expect(responses.at(-1)).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("fingerprints broad inputs without key enumeration and preserves tail sensitivity", () => {
    const toolInput = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`key-${index}`, `value-${index}`]),
    );
    const request = {
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      toolName: "exec",
      toolInput,
    } as const;
    const objectKeys = vi.spyOn(Object, "keys").mockImplementation(() => {
      throw new Error("Object.keys should not be used for permission fingerprints");
    });
    try {
      expect(testing.permissionRequestToolInputKeyFingerprintForTests(toolInput)).toContain("key-");
      const fingerprint = testing.permissionRequestContentFingerprintForTests(request);
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(fingerprint).not.toBe(
        testing.permissionRequestContentFingerprintForTests({
          ...request,
          toolInput: { ...toolInput, "key-299": "changed" },
        }),
      );
    } finally {
      objectKeys.mockRestore();
    }
  });

  it.each([
    {
      kind: "control characters",
      request: {
        cwd: "/repo\u001b[31m/red\u001b[0m",
        model: "gpt-5.4\u202edenied",
        toolInput: { command: "printf 'ok'\r\n\u001b[31mred\u001b[0m" },
      },
      expected: "Tool: exec\nCwd: /repo/red\nModel: gpt-5.4 denied\nCommand: printf 'ok' red",
    },
    {
      kind: "omitted keys",
      request: {
        toolInput: Object.fromEntries(
          Array.from({ length: 13 }, (_, index) => [`key-${index}`, index]),
        ),
      },
      expected: "(1 omitted)",
    },
  ])("sanitizes PermissionRequest preview $kind", ({ kind, request, expected }) => {
    const description = testing.formatPermissionApprovalDescriptionForTests({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      toolName: "exec",
      ...request,
    });
    if (kind === "omitted keys") {
      expect(description).toContain(expected);
    } else {
      expect(description).toBe(expected);
    }
  });
});

describe("native hook relay command builder", () => {
  it("execs niced relays so the Codex timeout owns the relay process", () => {
    const command = buildNativeHookRelayCommand({
      provider: "codex",
      relayId: "relay-1",
      event: "post_tool_use",
      executable: "openclaw",
      nice: 10,
    });

    expect(command).toBe(
      process.platform === "win32"
        ? "openclaw hooks relay --provider codex --relay-id relay-1 --event post_tool_use --timeout 5000"
        : "exec nice -n 10 openclaw hooks relay --provider codex --relay-id relay-1 --event post_tool_use --timeout 5000",
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
