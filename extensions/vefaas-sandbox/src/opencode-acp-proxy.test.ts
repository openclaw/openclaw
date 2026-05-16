import { describe, expect, it } from "vitest";
import { rewriteAcpInputLine } from "./opencode-acp-proxy.mjs";

describe("opencode ACP proxy", () => {
  it("rewrites ACP cwd params to the remote VEFaaS workspace", () => {
    const line = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {
        cwd: "/tmp/local-openclaw-workspace",
        mcpServers: [],
      },
    })}\n`;

    expect(JSON.parse(rewriteAcpInputLine(line, "/workspace")).params.cwd).toBe("/workspace");
  });

  it("passes non-JSON and JSON-RPC messages without cwd through unchanged", () => {
    expect(rewriteAcpInputLine("not-json\n", "/workspace")).toBe("not-json\n");
    const line = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId: "sid",
      },
    })}\n`;

    expect(rewriteAcpInputLine(line, "/workspace")).toBe(line);
  });
});
