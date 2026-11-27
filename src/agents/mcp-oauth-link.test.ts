import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startOperatorMcpOAuthLink } from "./mcp-oauth-link.js";

describe("shared MCP sign-in links", () => {
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
