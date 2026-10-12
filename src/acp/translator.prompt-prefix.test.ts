/** Tests ACP prompt cwd redaction, timeout metadata, and provenance fallback. */
import os from "node:os";
import path from "node:path";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createPromptRequest, requireAcpObject } from "./translator.bridge-test-helpers.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

const sessionId = "session-1";
const sessionKey = "agent:main:main";
function fixture(provenanceMode?: "meta+receipt") {
  const sessionStore = createInMemorySessionStore();
  sessionStore.createSession({
    sessionId,
    sessionKey,
    cwd: path.join(os.homedir(), "openclaw-test"),
  });
  const request = vi.fn(async (method: string) => {
    if (method === "chat.send") {
      throw new Error("stop-after-send");
    }
    return {};
  });
  const agent = createAcpGatewayAgent(
    createAcpConnection(),
    createAcpGateway(request as GatewayClient["request"]),
    { sessionStore, prefixCwd: true, provenanceMode },
  );
  return { agent, request };
}
function payload(request: { mock: { calls: unknown[][] } }, index = 0) {
  const call = request.mock.calls[index];
  expect(call?.[0]).toBe("chat.send");
  expect(call?.[2]).toEqual({ timeoutMs: null });
  return requireAcpObject(call?.[1], `chat.send payload ${index}`);
}

describe("acp prompt metadata", () => {
  it("redacts home directory in prompt prefix", async () => {
    await withEnvAsync({ OPENCLAW_HOME: undefined, HOME: os.homedir() }, async () => {
      const { agent, request } = fixture();
      await expect(agent.prompt(createPromptRequest(sessionId, "hello"))).rejects.toThrow(
        "stop-after-send",
      );
      expect(payload(request).message).toMatch(/\[Working directory: ~[\\/]openclaw-test\]/);
    });
  });

  it("does not forward malformed prompt timeout metadata", async () => {
    for (const timeoutMs of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const { agent, request } = fixture();
      await expect(
        agent.prompt(createPromptRequest(sessionId, "hello", { timeoutMs })),
      ).rejects.toThrow("stop-after-send");
      expect(payload(request).timeoutMs).toBeUndefined();
    }
  });

  it("retries without provenance when the gateway rejects admin-only provenance fields", async () => {
    const { agent, request } = fixture("meta+receipt");
    request.mockRejectedValueOnce(
      Object.assign(new Error("system provenance fields require admin scope"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      }),
    );
    await expect(agent.prompt(createPromptRequest(sessionId, "hello"))).rejects.toThrow(
      "stop-after-send",
    );
    expect(request).toHaveBeenCalledTimes(2);
    const first = payload(request);
    expect(first.systemInputProvenance).toEqual({
      kind: "external_user",
      originSessionId: sessionId,
      sourceChannel: "acp",
      sourceTool: "openclaw_acp",
    });
    expect(first.systemProvenanceReceipt).toBeTypeOf("string");
    for (const field of [
      "[Source Receipt]",
      "bridge=openclaw-acp",
      `originSessionId=${sessionId}`,
      `targetSession=${sessionKey}`,
    ]) {
      expect(first.systemProvenanceReceipt).toContain(field);
    }
    const retry = payload(request, 1);
    expect(retry.systemInputProvenance).toBeUndefined();
    expect(retry.systemProvenanceReceipt).toBeUndefined();
  });
});
