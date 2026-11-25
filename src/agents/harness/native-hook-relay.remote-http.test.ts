import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import * as hooks from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import * as relays from "./native-hook-relay.js";
import * as fixture from "./native-hook-relay.test-support.js";

const { relayLog } = vi.hoisted(() => ({ relayLog: vi.fn() }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      if (subsystem !== "agents/harness/native-hook-relay") {
        return logger;
      }
      return {
        ...logger,
        info: (message: string, meta?: Record<string, unknown>) => relayLog("info", message, meta),
        warn: (message: string, meta?: Record<string, unknown>) => relayLog("warn", message, meta),
      };
    },
  };
});

async function withRemoteCallbackServer(run: (port: number) => Promise<void>): Promise<void> {
  const {
    claim,
    listener: server,
    releaseListener,
  } = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((req, res) => {
        void relays.dispatchNativeHookRelayHttpCallback(req, res);
      }),
  });
  try {
    await run(claim.port);
  } finally {
    server.closeAllConnections();
    try {
      await releaseListener();
    } finally {
      await claim.release();
    }
  }
}

afterEach(async () => {
  hooks.resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await fixture.clearNativeHookRelaysForTests();
});

it("requires a current relay capability and preserves policy denial over HTTP", async () => {
  await withRemoteCallbackServer(async (port) => {
    const admitExecution = vi.fn();
    const requestApproval = vi.fn(async () => "allow" as const);
    relays.testing.setNativeHookRelayPermissionApprovalRequesterForTests(requestApproval);
    const identity = {
      relayId: "remote-relay",
    } as const;
    const relay = fixture.registerOwnedTestNativeHookRelay({
      ...identity,
      allowedEvents: ["pre_tool_use"],
      generationMismatchGraceMs: 30_000,
      executionAdmission: { toolNames: ["exec"], admit: admitExecution },
    });
    try {
      await relay.ready;
      const payload = {
        provider: "codex",
        relayId: relay.relayId,
        generation: relay.generation,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "synthetic_probe",
          tool_use_id: "synthetic-probe",
          tool_input: {},
        },
      };
      const post = (token: string, patch = {}, suffix = relay.relayId, method = "POST") =>
        fetch(`http://127.0.0.1:${port}/__openclaw__/native-hook/${suffix}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify({ ...payload, ...patch }) } : {}),
          signal: AbortSignal.timeout(5_000),
        });
      expect((await post("operator-token")).status).toBe(403);
      const { token } = relay.enableRemoteCallback();
      expect((await post("wrong-token")).status).toBe(403);
      // Transport authentication grants access to policy evaluation, not permission to execute.
      const deny = vi.fn(async () => ({ block: true, blockReason: "remote policy denied" }));
      hooks.initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_tool_call", handler: deny, matcher: ["exec"] },
        ]),
      );
      const denied = await post(token, {
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "remote-policy-denial",
          tool_input: { command: "echo denied" },
        },
      });
      expect(denied.status).toBe(200);
      const deniedBody = await denied.json();
      expect(deniedBody).toMatchObject({ ok: true, result: { exitCode: 0, stderr: "" } });
      expect(JSON.parse(deniedBody.result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "remote policy denied",
        },
      });
      expect(admitExecution).not.toHaveBeenCalled();
      expect(requestApproval).not.toHaveBeenCalled();
      expect((await post(token, { relayId: "another-relay" })).status).toBe(403);
      expect((await post(token, {}, "another-relay")).status).toBe(403);
      expect((await post(token, { generation: "old-generation" })).status).toBe(410);
      expect((await post(token, { event: "post_tool_use" })).status).toBe(500);
      expect((await post(token, {}, relay.relayId, "GET")).status).toBe(404);
      expect((await post(token, {}, relay.relayId + "?token=ignored")).status).toBe(404);
      const replacement = fixture.registerOwnedTestNativeHookRelay(identity);
      await replacement.ready;
      const next = replacement.enableRemoteCallback();
      expect((await post(token, { generation: replacement.generation })).status).toBe(403);
      expect((await post(next.token, { generation: replacement.generation })).status).toBe(200);
      replacement.unregister();
      await replacement.drain();
      expect((await post(next.token, { generation: replacement.generation })).status).toBe(403);
      expect(() => replacement.enableRemoteCallback()).toThrow(/inactive/);
    } finally {
      relay.unregister();
    }
  });
});

it("accepts each remote tool callback once and logs every outcome", async () => {
  await withRemoteCallbackServer(async (port) => {
    const relay = fixture.registerOwnedTestNativeHookRelay({
      relayId: "remote-once",
      allowedEvents: ["pre_tool_use", "post_tool_use"],
    });
    try {
      await relay.ready;
      const { token } = relay.enableRemoteCallback();
      const post = (event: string, toolUseId?: string, suffix = relay.relayId) =>
        fetch(`http://127.0.0.1:${port}/__openclaw__/native-hook/${suffix}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            provider: "codex",
            relayId: relay.relayId,
            generation: relay.generation,
            event,
            rawPayload: {
              hook_event_name: event === "pre_tool_use" ? "PreToolUse" : "PostToolUse",
              tool_name: "Bash",
              ...(toolUseId ? { tool_use_id: toolUseId } : {}),
              tool_input: { command: "true" },
            },
          }),
          signal: AbortSignal.timeout(5_000),
        });
      relayLog.mockClear();
      expect((await post("pre_tool_use", "call-1")).status).toBe(200);
      // An identical body is a replay, not a second hook invocation.
      expect((await post("pre_tool_use", "call-1")).status).toBe(409);
      expect((await post("post_tool_use", "call-1")).status).toBe(200);
      expect((await post("post_tool_use", "call-1")).status).toBe(409);
      expect((await post("pre_tool_use")).status).toBe(409);
      expect((await post("pre_tool_use", "call-2", "unknown-relay")).status).toBe(403);
      const outcome = (event: string, toolUseId: string | undefined, status: number) => ({
        relayId: relay.relayId,
        event,
        toolUseId,
        status,
      });
      expect(
        relayLog.mock.calls.filter(([, message]) =>
          String(message).startsWith("native hook remote callback"),
        ),
      ).toEqual([
        [
          "info",
          "native hook remote callback",
          { consoleMessage: false, ...outcome("pre_tool_use", "call-1", 200) },
        ],
        ["warn", "native hook remote callback refused", outcome("pre_tool_use", "call-1", 409)],
        [
          "info",
          "native hook remote callback",
          { consoleMessage: false, ...outcome("post_tool_use", "call-1", 200) },
        ],
        ["warn", "native hook remote callback refused", outcome("post_tool_use", "call-1", 409)],
        ["warn", "native hook remote callback refused", outcome("pre_tool_use", undefined, 409)],
        ["warn", "native hook remote callback refused", { relayId: "unknown-relay", status: 403 }],
      ]);
    } finally {
      relay.unregister();
    }
  });
});
