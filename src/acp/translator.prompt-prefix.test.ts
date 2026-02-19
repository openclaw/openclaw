import os from "node:os";
import path from "node:path";
import type { AgentSideConnection, PromptRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";

function createConnection(): AgentSideConnection {
  return {
    sessionUpdate: vi.fn(async () => {}),
  } as unknown as AgentSideConnection;
}

describe("acp prompt cwd prefix", () => {
  it("redacts home directory in prompt prefix", async () => {
    const sessionStore = createInMemorySessionStore();
    const homeCwd = path.join(os.homedir(), "openclaw-test");
    sessionStore.createSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      cwd: homeCwd,
    });

    const requestSpy = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        throw new Error("stop-after-send");
      }
      return {};
    });
    const gateway = {
      request: requestSpy,
    } as unknown as GatewayClient;

    const agent = new AcpGatewayAgent(createConnection(), gateway, {
      sessionStore,
      prefixCwd: true,
    });

    await expect(
      agent.prompt({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "hello" }],
        _meta: {},
      } as unknown as PromptRequest),
    ).rejects.toThrow("stop-after-send");

    expect(requestSpy).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        message: expect.stringMatching(/\[Working directory: ~[\\/]openclaw-test\]/),
      }),
      { expectFinal: true },
    );
  });
});
