import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveMcpOAuthLinkRedirectUrl, startOperatorMcpOAuthLink } from "./mcp-oauth-link.js";

describe("shared MCP sign-in links", () => {
  it.each([
    [{ gateway: { port: 18790 } }, "http://127.0.0.1:18790/oauth/mcp/callback"],
    [
      { gateway: { publicOrigin: "https://gateway.example.com", port: 18790 } },
      "https://gateway.example.com/oauth/mcp/callback",
    ],
  ] satisfies [OpenClawConfig, string][])(
    "uses the Gateway's redirect origin for %j",
    (cfg, expected) => {
      expect(resolveMcpOAuthLinkRedirectUrl(cfg)).toBe(expected);
    },
  );

  it.each([
    {},
    { mcp: { servers: { docs: { url: "https://mcp.example.com" } } } },
    {
      mcp: {
        servers: {
          docs: {
            url: "https://mcp.example.com",
            auth: "oauth",
            oauth: { identity: "per-requester" },
          },
        },
      },
    },
  ] satisfies OpenClawConfig[])(
    "rejects servers without a shared OAuth connection: %j",
    async (cfg) => {
      await expect(startOperatorMcpOAuthLink({ cfg, serverName: "docs" })).rejects.toThrow(
        "This MCP server has no shared OAuth sign-in.",
      );
    },
  );
});
