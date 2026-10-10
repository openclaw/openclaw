import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import {
  dispatchNativeHookRelayHttpCallback,
  registerOwnedNativeHookRelay,
  testing,
} from "./native-hook-relay.js";

afterEach(async () => {
  vi.restoreAllMocks();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await testing.clearNativeHookRelaysForTests();
});

describe("dedicated native hook callback", () => {
  it("requires a current relay capability and preserves policy denial over HTTP", async () => {
    const {
      claim,
      listener: server,
      releaseListener,
    } = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((req, res) => {
          void dispatchNativeHookRelayHttpCallback(req, res);
        }),
    });
    const admitExecution = vi.fn();
    const requestApproval = vi.fn(async () => "allow" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(requestApproval);
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      relayId: "remote-relay",
      allowedEvents: ["pre_tool_use"],
      preToolUseLoopDetection: false,
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
        rawPayload: { hook_event_name: "PreToolUse", tool_name: "synthetic_probe", tool_input: {} },
      };
      const post = (token: string, patch = {}, suffix = relay.relayId, method = "POST") =>
        fetch(`http://127.0.0.1:${claim.port}/__openclaw__/native-hook/${suffix}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify({ ...payload, ...patch }) } : {}),
          signal: AbortSignal.timeout(5_000),
        });
      expect((await post("operator-token")).status).toBe(403);
      const { token } = relay.enableRemoteCallback();
      expect((await post("wrong-token")).status).toBe(403);
      const accepted = await post(token);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ ok: true, result: { exitCode: 0 } });
      // Transport authentication grants access to policy evaluation, not permission to execute.
      const beforeToolCall = vi.fn(async () => ({
        block: true,
        blockReason: "remote policy denied",
      }));
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_tool_call", handler: beforeToolCall, matcher: ["exec"] },
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
      expect(beforeToolCall).toHaveBeenCalledOnce();
      expect(admitExecution).not.toHaveBeenCalled();
      expect(requestApproval).not.toHaveBeenCalled();
      expect((await post(token, { relayId: "another-relay" })).status).toBe(403);
      expect((await post(token, {}, "another-relay")).status).toBe(403);
      expect((await post(token, { generation: "old-generation" })).status).toBe(410);
      expect((await post(token, { event: "post_tool_use" })).status).toBe(500);
      expect((await post(token, {}, relay.relayId, "GET")).status).toBe(404);
      expect((await post(token, {}, relay.relayId + "?token=ignored")).status).toBe(404);
      const replacement = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        relayId: relay.relayId,
        preToolUseLoopDetection: false,
      });
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
      server.closeAllConnections();
      try {
        await releaseListener();
      } finally {
        await claim.release();
      }
    }
  });
});
