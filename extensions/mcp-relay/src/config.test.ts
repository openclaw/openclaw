import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { parseMcpRelayConfig } from "./config.js";

describe("MCP relay configuration", () => {
  it("defaults to the public HTTPS relay and preserves the selected agent", () => {
    expect(parseMcpRelayConfig(undefined)).toEqual({ relayUrl: "https://mcp.openclaw.ai" });
    expect(
      parseMcpRelayConfig({ relayUrl: "https://relay.example:8443/", agentId: "work" }),
    ).toEqual({
      relayUrl: "https://relay.example:8443",
      agentId: "work",
    });
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:8787"])(
    "allows the development origin %s",
    (relayUrl) => {
      expect(parseMcpRelayConfig({ relayUrl })).toEqual({ relayUrl });
    },
  );

  it.each([
    "http://relay.example",
    "http://localhost.evil.example",
    "http://127.0.0.2",
    "ws://localhost",
    "https://user:password@relay.example",
    "https://relay.example/mcp",
    "https://relay.example/?token=secret",
    "https://relay.example/#fragment",
    "https://relay.example?",
    "https://relay.example#",
    "https://relay.example:99999",
    "https://relay.example/../",
    "not a URL",
    "",
  ])("rejects an invalid relay origin: %s", (relayUrl) => {
    expect(() => parseMcpRelayConfig({ relayUrl })).toThrow("relayUrl");
  });

  it.each([null, [], { enabled: true }, { relayUrl: 1 }, { agentId: " " }, { agentId: 1 }])(
    "rejects unsupported config %j",
    (config) => {
      expect(() => parseMcpRelayConfig(config)).toThrow();
    },
  );

  it.each([
    "https://relay.example\\",
    "https://relay.example\\other",
    "http://localhost\\",
    "http://127.0.0.1\\",
  ])("rejects backslashes consistently in cold metadata and runtime config: %s", (relayUrl) => {
    expect(new RegExp(manifest.configSchema.properties.relayUrl.pattern).test(relayUrl)).toBe(
      false,
    );
    expect(() => parseMcpRelayConfig({ relayUrl })).toThrow("relayUrl");
  });
});
