import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
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
    "https://gateway.example",
    "https://gateway.example:8443/",
    "https://gateway.example/openclaw/",
    "https://gateway.example/openclaw/chat",
    "https://[2001:db8::1]:8443/openclaw/",
  ])("accepts the Control UI URL in cold metadata and runtime config: %s", (controlUiUrl) => {
    const config = { controlUiUrl };
    expect(validateJsonSchemaValue({ schema: manifest.configSchema, value: config }).ok).toBe(true);
    expect(parseMcpRelayConfig(config)).toEqual({
      relayUrl: "https://mcp.openclaw.ai",
      controlUiUrl,
    });
  });

  it.each([
    "http://gateway.example",
    "http://localhost:18789/",
    "//gateway.example/",
    "/openclaw/",
    "https:gateway.example",
    "https:///gateway.example",
    "https://user:password@gateway.example/",
    "https://@gateway.example/",
    "https://gateway.example/?token=secret",
    "https://gateway.example/#token=secret",
    "https://gateway.example/?",
    "https://gateway.example/#",
    "https://gateway.example:99999/",
    "https://gateway.example\\openclaw",
    "https://gateway.example/open claw/",
    "https://gateway.example/\n",
    "https://gateway.example/\u0000",
    "not a URL",
    "",
    null,
    1,
  ])(
    "rejects an invalid Control UI URL in cold metadata and runtime config: %j",
    (controlUiUrl) => {
      const config = { controlUiUrl };
      expect(validateJsonSchemaValue({ schema: manifest.configSchema, value: config }).ok).toBe(
        false,
      );
      expect(() => parseMcpRelayConfig(config)).toThrow("controlUiUrl");
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
