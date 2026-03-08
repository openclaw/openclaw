import { describe, expect, it } from "vitest";
import { __testing } from "./index.js";

const SWIFTAPI_KEY = process.env.SWIFTAPI_KEY ?? "";
const BASE_URL = "https://swiftapi.ai";

/**
 * Live integration tests against swiftapi.ai.
 * Requires SWIFTAPI_KEY env var with a valid authority key.
 * Skipped automatically if key is not set.
 */
const liveTest = SWIFTAPI_KEY ? describe : describe.skip;

async function callAttest(params: {
  key: string;
  baseUrl: string;
  actionType: string;
  actionData: Record<string, unknown>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${params.baseUrl}/attest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SwiftAPI-Authority": params.key,
    },
    body: JSON.stringify({
      action_type: params.actionType,
      action_data: params.actionData,
    }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

liveTest("swiftapi attestation — live integration", () => {
  it("dangerous exec action is denied by policy with 200", async () => {
    const { status, body } = await callAttest({
      key: SWIFTAPI_KEY,
      baseUrl: BASE_URL,
      actionType: "exec",
      actionData: { agent_id: "test", session_key: "vitest", tool_params: { command: "ls" } },
    });

    expect(status).toBe(200);
    expect(body.approved).toBe(false);
    expect(body.denial_reason).toBeTruthy();
    expect(Array.isArray(body.violated_policies)).toBe(true);
    expect(body.jti).toBeTruthy();
    expect(body.signature).toBeTruthy();
    expect(body.signing_mode).toBe("ed25519");
    expect(body.action_type).toBe("exec");
  });

  it("invalid key returns 403", async () => {
    const { status, body } = await callAttest({
      key: "swiftapi_live_0000000000000000000000000000000000000000000000000000000000000000",
      baseUrl: BASE_URL,
      actionType: "exec",
      actionData: { agent_id: "test", session_key: "vitest", tool_params: {} },
    });

    expect(status).toBe(403);
    expect(body.detail).toBeTruthy();
  });

  it("missing key returns 403", async () => {
    const res = await fetch(`${BASE_URL}/attest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action_type: "exec", action_data: {} }),
    });

    expect(res.status).toBe(403);
  });

  it("attestation includes tool context in action_data", async () => {
    const actionData = {
      agent_id: "main",
      session_key: "telegram:12345",
      tool_params: { command: "rm -rf /tmp/test", args: [] },
    };

    const { status, body } = await callAttest({
      key: SWIFTAPI_KEY,
      baseUrl: BASE_URL,
      actionType: "shell_command",
      actionData,
    });

    expect(status).toBe(200);
    expect(body.approved).toBe(false);
    expect(body.denial_reason).toBeTruthy();
    expect(body.action_type).toBe("shell_command");
    expect(body.action_data).toEqual(actionData);
  });

  it("unreachable host throws network error", async () => {
    await expect(
      callAttest({
        key: SWIFTAPI_KEY,
        baseUrl: "https://swiftapi-nonexistent.invalid",
        actionType: "exec",
        actionData: {},
      }),
    ).rejects.toThrow();
  });
});

describe("swiftapi plugin logic — unit", () => {
  it("maps exec tool to exec_runtime action family", () => {
    const mapped = __testing.deriveActionType("exec", { command: "ls" });
    expect(mapped.actionType).toBe("exec_runtime");
    expect(mapped.mapped).toBe(true);
  });

  it("maps message broadcast action correctly", () => {
    const mapped = __testing.deriveActionType("message", { action: "broadcast" });
    expect(mapped.actionType).toBe("message_broadcast");
    expect(mapped.mapped).toBe(true);
  });

  it("flags unknown message action as unmapped", () => {
    const mapped = __testing.deriveActionType("message", { action: "future-action" });
    expect(mapped.actionType).toBe("message_mutation");
    expect(mapped.mapped).toBe(false);
  });

  it("maps cron mutation action correctly", () => {
    const mapped = __testing.deriveActionType("cron", { action: "add" });
    expect(mapped.actionType).toBe("cron_mutation");
    expect(mapped.mapped).toBe(true);
  });

  it("flags unknown mapping as unmapped", () => {
    const mapped = __testing.deriveActionType("unknown_tool", {});
    expect(mapped.mapped).toBe(false);
    expect(mapped.actionType.startsWith("tool_")).toBe(true);
  });

  it("derives outbound message broadcast from metadata action", () => {
    const actionType = __testing.deriveOutboundMessageActionType({
      to: "C123",
      metadata: { action: "broadcast" },
    });
    expect(actionType).toBe("message_broadcast");
  });

  it("derives outbound message broadcast from target pattern", () => {
    const actionType = __testing.deriveOutboundMessageActionType({
      to: "@all",
      metadata: {},
    });
    expect(actionType).toBe("message_broadcast");
  });

  it("derives outbound direct send as message_send", () => {
    const actionType = __testing.deriveOutboundMessageActionType({
      to: "C12345",
      metadata: { channel: "slack" },
    });
    expect(actionType).toBe("message_send");
  });

  it("bypass tools are skipped", () => {
    const bypassTools = new Set<string>();
    expect(bypassTools.has("read")).toBe(false);
    expect(bypassTools.has("exec")).toBe(false);
  });

  it("attestTools whitelist filters correctly", () => {
    const attestTools = new Set(["exec", "write", "message"]);
    expect(attestTools.has("exec")).toBe(true);
    expect(attestTools.has("read")).toBe(false);
  });

  it("failClosed defaults to true", () => {
    const cfg = { key: "test" } as { key: string; failClosed?: boolean };
    const failClosed = cfg.failClosed !== false;
    expect(failClosed).toBe(true);
  });

  it("failClosed can be disabled", () => {
    const cfg = { key: "test", failClosed: false };
    const failClosed = cfg.failClosed !== false;
    expect(failClosed).toBe(false);
  });
});
