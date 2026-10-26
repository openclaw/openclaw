import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import * as hooks from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import * as relays from "./native-hook-relay.js";
import * as fixture from "./native-hook-relay.test-support.js";

afterEach(async () => {
  hooks.resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await fixture.clearNativeHookRelaysForTests();
});

it("requires a current relay capability and preserves policy denial over HTTP", async () => {
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
  const admitExecution = vi.fn();
  const requestApproval = vi.fn(async () => "allow" as const);
  relays.testing.setNativeHookRelayPermissionApprovalRequesterForTests(requestApproval);
  const identity = {
    relayId: "remote-relay",
    preToolUseLoopDetection: false,
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
    server.closeAllConnections();
    try {
      await releaseListener();
    } finally {
      await claim.release();
    }
  }
});
