Total output lines: 3253

// Covers native hook relay registration, bridge invocation, and approval state.
import { randomUUID } from "node:crypto";
import { rmSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { patchPluginSessionExtension } from "../../plugins/host-hook-state.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  testing,
  buildNativeHookRelayCommand,
  hasNativeHookRelayInvocation,
  invokeNativeHookRelay,
  invokeNativeHookRelayBridge,
  registerNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
} from "./native-hook-relay.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  testing.clearNativeHookRelaysForTests();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  // Relay bridge payloads cross a process boundary. Tests narrow unknown JSON
  // before making assertions so malformed bridge responses fail clearly.
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

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
): Promise<Record<string, unknown>> {
  let record: Record<string, unknown> | undefined;
  await vi.waitFor(() => {
    record = testing.getNativeHookRelayBridgeRecordForTests(relayId);
    expect(isRecord(record) ? record.relayId : undefined).toBe(relayId);
  });
  return record as Record<string, unknown>;
}

async function writeForeignNativeHookRelayBridgeRecordForTests(
  relayId: string,
  record: {
    pid: number;
    expiresAtMs: number;
  },
): Promise<string> {
  // Foreign bridge records simulate another process owning the relay server,
  // without starting a second OpenClaw process in the unit test.
  const bridgeDir = testing.getNativeHookRelayBridgeDirForTests();
  await fs.mkdir(bridgeDir, { recursive: true, mode: 0o700 });
  const registryPath = testing.getNativeHookRelayBridgeRegistryPathForTests(relayId);
  writeFileSync(
    registryPath,
    `${JSON.stringify({
      version: 1,
      relayId,
      pid: record.pid,
      hostname: "127.0.0.1",
      port: 9,
      token: `token-${relayId}`,
      expiresAtMs: record.expiresAtMs,
    })}\n`,
    { mode: 0o600 },
  );
  return registryPath;
}

function uniqueNativeHookRelayIdForTests(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function openDeferredNativeHookRelayBridgeRequest(
  record: Record<string, unknown>,
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
      hostname: String(record.hostname),
      method: "POST",
      path: "/invoke",
      port: Number(record.port),
      headers: {
        authorization: `Bearer ${String(record.token)}`,
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
  relayBridges: Map<string, unknown>;
  invocations: unknown[];
  pendingPermissionApprovals: Map<string, unknown>;
  permissionApprovalWindows: Map<string, unknown[]>;
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
      "/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id " +
        `${relay.relayId} --generation ${relay.generation} --event pre_tool_use --pre-tool-use-unavailable loop-detection-only --timeout 1234`,
    );
    expect(relay.commandForEvent("pre_tool_use", { timeoutMs: 900 })).toBe(
      "/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id " +
        `${relay.relayId} --generation ${relay.generation} --event pre_tool_use --pre-tool-use-unavailable loop-detection-only --timeout 900`,
    );
    expect(relay.commandForEvent("pre_tool_use", { timeoutMs: 2_000 })).toBe(
      "/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id " +
        `${relay.relayId} --generation ${relay.generation} --event pre_tool_use --pre-tool-use-unavailable loop-detection-only --timeout 1234`,
    );
  });

  it("rejects relay registrations when expiry would exceed Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    expect(() =>
      registerNativeHookRelay({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        allowedEvents: ["pre_tool_use"],
      }),
    ).toThrow("Native hook relay expiry is outside the supported Date range");
  });

  it("stores relay registrations, bridges, and invocations in process-global state", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-global-state-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });
    const state = getNativeHookRelaySharedStateForTests();

    expect(state.relays.get(relay.relayId)).toMatchObject({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    await waitForNativeHookRelayBridgeRecord(relay.relayId);
    expect(state.relayBridges.get(relay.relayId)).toMatchObject({
      relayId: relay.relayId,
    });

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      },
    });

    expect(state.invocations.at(-1)).toMatchObject({
      relayId: relay.relayId,
      event: "pre_tool_use",
    });
  });

  it("stores permission approval state in process-global state", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-global-permission-state",
      sessionId: "session-1",
      runId: "run-1",
    });
    let resolveDecision: ((decision: "allow-always") => void) | undefined;
    const pendingDecision = new Promise<"allow-always">((resolve) => {
      resolveDecision = resolve;
    });
    const approvalRequester = vi.fn(() => pendingDecision);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const first = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "browserforce tabs" },
      },
    });
    await Promise.resolve();

    const state = getNativeHookRelaySharedStateForTests();
    expect(state.pendingPermissionApprovals.size).toBe(1);
    expect(state.permissionApprovalWindows.get(relay.relayId)).toHaveLength(1);

    resolveDecision?.("allow-always");
    await expect(first).resolves.toMatchObject({ exitCode: 0 });
    expect(state.pendingPermissionApprovals.size).toBe(0);
    expect(state.permissionAllowAlwaysApprovals.size).toBe(1);

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          cwd: "/repo",
          tool_name: "Bash",
          tool_use_id: "native-call-2",
          tool_input: { command: "browserforce tabs" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(approvalRequester).toHaveBeenCalledTimes(1);
  });

  it("does not remember allow-always approvals when expiry would exceed Date range", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-permission-overflow-session",
      sessionId: "session-1",
      runId: "run-1",
    });
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
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          cwd: "/repo",
          tool_name: "Bash",
          tool_use_id: "native-call-1",
          tool_input: { command: "browserforce tabs" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(state.permissionAllowAlwaysApprovals.size).toBe(0);

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          cwd: "/repo",
          tool_name: "Bash",
          tool_use_id: "native-call-2",
          tool_input: { command: "browserforce tabs" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(approvalRequester).toHaveBeenCalledTimes(2);
  });

  it("shares relay state across duplicate module instances", async () => {
    const duplicateModule = await importDuplicateNativeHookRelayModuleForTests();
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-duplicate-module-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use", "permission_request"],
    });

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
    const duplicateApproval = await duplicateModule.invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "browserforce tabs" },
      },
    });
    expect(JSON.parse(duplicateApproval.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });

    const primaryApprovalRequester = vi.fn(async () => "deny" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(primaryApprovalRequester);
    const primaryApproval = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-2",
        tool_input: { command: "browserforce tabs" },
      },
    });
    expect(JSON.parse(primaryApproval.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });

    expect(duplicateApprovalRequester).toHaveBeenCalledTimes(1);
    expect(primaryApprovalRequester).not.toHaveBeenCalled();

    const replacement = duplicateModule.registerNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });
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
          tool_response: { output: "ok" },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    replacement.unregister();
  });

  it("preserves permission relays while marking hook-only events without handlers inactive", () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      command: {
        executable: "/opt/Open Claw/openclaw.mjs",
        nodeExecutable: "/usr/local/bin/node",
        timeoutMs: 1234,
      },
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(false);
    expect(relay.shouldRelayEvent("post_tool_use")).toBe(false);
    expect(relay.shouldRelayEvent("before_agent_finalize")).toBe(false);
    expect(relay.shouldRelayEvent("permission_request")).toBe(true);
    expect(relay.commandForEvent("pre_tool_use")).toBe(
      "/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id " +
        `${relay.relayId} --generation ${relay.generation} --event pre_tool_use --pre-tool-use-unavailable noop --timeout 1234`,
    );
  });

  it("builds pre-tool relay commands only when before-tool policy is active", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      command: {
        executable: "/opt/Open Claw/openclaw.mjs",
        nodeExecutable: "/usr/local/bin/node",
        timeoutMs: 1234,
      },
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);
    expect(relay.commandForEvent("pre_tool_use")).toBe(
      "/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id " +
        `${relay.relayId} --generation ${relay.generation} --event pre_tool_use --timeout 1234`,
    );
  });

  it("keeps pre-tool relays active when native loop detection is not disabled", () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      command: {
        executable: "/opt/Open Claw/openclaw.mjs",
        nodeExecutable: "/usr/local/bin/node",
        timeoutMs: 1234,
      },
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);
    expect(relay.commandForEvent("pre_tool_use")).toBe(
      "/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id " +
        `${relay.relayId} --generation ${relay.generati…16105 tokens truncated…lRequester = vi
      .fn()
      .mockResolvedValueOnce("allow" as const)
      .mockResolvedValueOnce("deny" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const allow = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        model: "gpt-5.4",
        tool_name: "Bash",
        tool_input: { command: "git push" },
      },
    });
    const deny = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "curl https://example.com" },
      },
    });

    expect(JSON.parse(allow.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(JSON.parse(deny.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Denied by user" },
      },
    });
    const request = getMockCallArg(approvalRequester, 0, 0, "approval request");
    expectRecordFields(request, {
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      toolName: "exec",
      cwd: "/repo",
      model: "gpt-5.4",
      toolInput: { command: "git push" },
    });
  });

  it("reuses allow-always PermissionRequest approvals for identical relay content", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-stable-permission-cache",
      sessionId: "session-1",
      runId: "run-1",
    });
    const approvalRequester = vi.fn(async () => "allow-always" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const first = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "browserforce tabs" },
      },
    });
    relay.unregister();
    registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-stable-permission-cache",
      sessionId: "session-1",
      runId: "run-2",
    });
    const second = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-2",
        tool_input: { command: "browserforce tabs" },
      },
    });

    expect(approvalRequester).toHaveBeenCalledTimes(1);
    expect([first, second].map((response) => JSON.parse(response.stdout))).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      },
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      },
    ]);
  });

  it("does not reuse allow-always PermissionRequest approvals across sessions with the same relay id", async () => {
    const relayId = "codex-stable-permission-cache-cross-session";
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });
    const approvalRequester = vi.fn(async () => "allow-always" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: first.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "browserforce tabs" },
      },
    });
    first.unregister();
    const second = registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
      runId: "run-2",
    });
    await invokeNativeHookRelay({
      provider: "codex",
      relayId: second.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-2",
        tool_input: { command: "browserforce tabs" },
      },
    });

    expect(approvalRequester).toHaveBeenCalledTimes(2);
    const request = getMockCallArg(approvalRequester, 1, 0, "second approval request");
    expectRecordFields(request, {
      agentId: "agent-1",
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
      toolInput: { command: "browserforce tabs" },
    });
  });

  it("keeps allow-always PermissionRequest reuse scoped to matching cwd and input", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    const approvalRequester = vi.fn(async () => "allow-always" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo-a",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      },
    });
    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo-b",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      },
    });
    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo-a",
        tool_name: "Bash",
        tool_input: { command: "npm test -- --changed" },
      },
    });

    expect(approvalRequester).toHaveBeenCalledTimes(3);
  });

  it("defers PermissionRequest when OpenClaw approval does not decide", async () => {
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(
      vi.fn(async () => "defer" as const),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "cargo test" },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("deduplicates pending PermissionRequest approvals by relay, run, and tool call", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    let resolveDecision: ((decision: "allow") => void) | undefined;
    const pendingDecision = new Promise<"allow">((resolve) => {
      resolveDecision = resolve;
    });
    const approvalRequester = vi.fn(() => pendingDecision);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const payload = {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_use_id: "native-call-1",
      tool_input: { command: "git push" },
    };
    const first = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: payload,
    });
    const second = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: payload,
    });

    await Promise.resolve();
    expect(approvalRequester).toHaveBeenCalledTimes(1);
    resolveDecision?.("allow");
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => JSON.parse(response.stdout))).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      },
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      },
    ]);
  });

  it("keeps replacement pending PermissionRequest approvals when stale approvals settle", async () => {
    const relayId = "codex-stale-pending-permission";
    const firstRelay = registerNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-1",
      runId: "run-1",
    });
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

    const firstApproval = invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "permission_request",
      rawPayload: payload,
    });
    await Promise.resolve();
    expect(approvalRequester).toHaveBeenCalledTimes(1);
    expect(getNativeHookRelaySharedStateForTests().pendingPermissionApprovals.size).toBe(1);

    firstRelay.unregister();
    registerNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-1",
      runId: "run-1",
    });
    const secondApproval = invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "permission_request",
      rawPayload: payload,
    });
    await Promise.resolve();
    expect(approvalRequester).toHaveBeenCalledTimes(2);
    expect(getNativeHookRelaySharedStateForTests().pendingPermissionApprovals.size).toBe(1);

    resolvers[0]?.("allow");
    await expect(firstApproval).resolves.toMatchObject({ exitCode: 0 });
    expect(getNativeHookRelaySharedStateForTests().pendingPermissionApprovals.size).toBe(1);

    const duplicateSecondApproval = invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "permission_request",
      rawPayload: payload,
    });
    await Promise.resolve();
    expect(approvalRequester).toHaveBeenCalledTimes(2);

    resolvers[1]?.("allow");
    await expect(Promise.all([secondApproval, duplicateSecondApproval])).resolves.toHaveLength(2);
    expect(getNativeHookRelaySharedStateForTests().pendingPermissionApprovals.size).toBe(0);
  });

  it("does not reuse pending PermissionRequest approvals when a tool call id is reused with different input", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    let resolveDecision: ((decision: "allow") => void) | undefined;
    const pendingDecision = new Promise<"allow">((resolve) => {
      resolveDecision = resolve;
    });
    const approvalRequester = vi.fn(async (request: { toolInput?: Record<string, unknown> }) => {
      return request.toolInput?.command === "git status" ? pendingDecision : "deny";
    });
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const first = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_use_id: "reused-call-id",
        tool_input: { command: "git status" },
      },
    });
    const second = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_use_id: "reused-call-id",
        tool_input: { command: "rm -rf /tmp/openclaw-important-state" },
      },
    });

    await Promise.resolve();
    expect(approvalRequester).toHaveBeenCalledTimes(2);
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
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    const approvalRequester = vi.fn(async () => "allow" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const responses = [];
    for (let index = 0; index < 13; index += 1) {
      responses.push(
        await invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "permission_request",
          rawPayload: {
            hook_event_name: "PermissionRequest",
            tool_name: "Bash",
            tool_use_id: `native-call-${index}`,
            tool_input: { command: `echo ${index}` },
          },
        }),
      );
    }

    expect(approvalRequester).toHaveBeenCalledTimes(12);
    expect(responses.at(-1)).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("deduplicates pending PermissionRequest approvals before consuming approval budget", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    const resolvers: Array<(decision: "allow") => void> = [];
    const approvalRequester = vi.fn(
      () =>
        new Promise<"allow">((resolve) => {
          resolvers.push(resolve);
        }),
    );
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const duplicatePayload = {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_use_id: "native-call-1",
      tool_input: { command: "git push" },
    };
    const duplicateRequests = Array.from({ length: 12 }, () =>
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: duplicatePayload,
      }),
    );
    await Promise.resolve();
    expect(approvalRequester).toHaveBeenCalledTimes(1);

    const newRequest = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        ...duplicatePayload,
        tool_use_id: "native-call-2",
        tool_input: { command: "curl https://example.com" },
      },
    });
    await Promise.resolve();
    expect(approvalRequester).toHaveBeenCalledTimes(2);

    for (const resolve of resolvers) {
      resolve("allow");
    }
    await expect(Promise.all([...duplicateRequests, newRequest])).resolves.toHaveLength(13);
  });

  it("uses canonical PermissionRequest content fingerprints for ordinary objects", () => {
    const first = testing.permissionRequestContentFingerprintForTests({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      toolName: "exec",
      toolInput: { a: 1, b: { x: 2, y: 3 } },
    });
    const second = testing.permissionRequestContentFingerprintForTests({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      toolName: "exec",
      toolInput: { b: { y: 3, x: 2 }, a: 1 },
    });

    expect(second).toBe(first);
  });

  it("keeps broad PermissionRequest content fingerprints sensitive to tail changes", () => {
    const firstToolInput = Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => [`key-${index}`, `value-${index}`]),
    );
    const secondToolInput = {
      ...firstToolInput,
      "key-204": "changed",
    };

    expect(
      testing.permissionRequestContentFingerprintForTests({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "exec",
        toolInput: firstToolInput,
      }),
    ).not.toBe(
      testing.permissionRequestContentFingerprintForTests({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "exec",
        toolInput: secondToolInput,
      }),
    );
  });

  it("fingerprints broad PermissionRequest inputs without Object.keys enumeration", () => {
    const toolInput = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`key-${index}`, `value-${index}`]),
    );
    const objectKeys = vi.spyOn(Object, "keys").mockImplementation(() => {
      throw new Error("Object.keys should not be used for permission fingerprints");
    });

    try {
      expect(testing.permissionRequestToolInputKeyFingerprintForTests(toolInput)).toContain("key-");
      expect(
        testing.permissionRequestContentFingerprintForTests({
          provider: "codex",
          sessionId: "session-1",
          runId: "run-1",
          toolName: "exec",
          toolInput,
        }),
      ).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      objectKeys.mockRestore();
    }
  });

  it("sanitizes PermissionRequest approval previews and reports omitted keys", () => {
    expect(
      testing.formatPermissionApprovalDescriptionForTests({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "exec",
        cwd: "/repo\u001b[31m/red\u001b[0m",
        model: "gpt-5.4\u202edenied",
        toolInput: {
          command: "printf 'ok'\r\n\u001b[31mred\u001b[0m",
        },
      }),
    ).toBe("Tool: exec\nCwd: /repo/red\nModel: gpt-5.4 denied\nCommand: printf 'ok' red");

    expect(
      testing.formatPermissionApprovalDescriptionForTests({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "exec",
        toolInput: Object.fromEntries(
          Array.from({ length: 13 }, (_, index) => [`key-${index}`, index]),
        ),
      }),
    ).toContain("(1 omitted)");
  });
});

describe("native hook relay command builder", () => {
  it("uses the Codex hook relay command shape", () => {
    expect(
      buildNativeHookRelayCommand({
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "permission_request",
        executable: "openclaw",
      }),
    ).toBe(
      "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 5000",
    );
  });

  it("includes explicit unavailable noop mode only for PreToolUse", () => {
    expect(
      buildNativeHookRelayCommand({
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        preToolUseUnavailable: "noop",
        executable: "openclaw",
      }),
    ).toBe(
      "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event pre_tool_use --pre-tool-use-unavailable noop --timeout 5000",
    );
  });
});
