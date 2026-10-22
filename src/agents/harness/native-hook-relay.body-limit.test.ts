import { afterEach, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readNativeHookRelayBridgeRecord } from "./native-hook-relay-store.js";
import { registerOwnedNativeHookRelay } from "./native-hook-relay.js";
import { clearNativeHookRelaysForTests } from "./native-hook-relay.test-support.js";

afterEach(clearNativeHookRelaysForTests);

it.each([5_000_000, 5_000_001])("bounds direct bridge requests at %s bytes", async (size) => {
  await withOpenClawTestState({ label: "relay-request-limit" }, async () => {
    const policy = vi.fn(async () => ({ blocked: false as const, params: {} }));
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "request-limit",
      runId: "request-limit",
      runBeforeToolCall: policy,
    });
    try {
      await relay.ready;
      const record = await readNativeHookRelayBridgeRecord({ relayId: relay.relayId });
      if (!record) {
        throw new Error("fixture bridge missing");
      }
      const payload = JSON.stringify({
        provider: "codex",
        relayId: relay.relayId,
        generation: relay.generation,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      });
      const response = await fetch(`http://${record.hostname}:${record.port}/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${record.token}`, connection: "close" },
        body: payload + " ".repeat(size - Buffer.byteLength(payload)),
      });
      if (size === 5_000_000) {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ ok: true, result: { exitCode: 0 } });
        expect(policy).toHaveBeenCalledOnce();
      } else {
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
          ok: false,
          error: "native hook relay bridge payload too large",
        });
        expect(policy).not.toHaveBeenCalled();
      }
    } finally {
      relay.unregister();
      await relay.drain();
    }
  });
});
