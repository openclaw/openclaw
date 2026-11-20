import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it } from "vitest";
import { sessionShareGatewayEnabled } from "./config.js";

it("requires independent explicit host and source publication opt-ins", () => {
  const config: OpenClawConfig = {
    plugins: {
      entries: { "session-share": { enabled: true, config: { share: { gateway: true } } } },
    },
  };
  expect(sessionShareGatewayEnabled(config)).toBe(false);
  config.gateway = { sessionControl: { publicationReadEnabled: true } };
  expect(sessionShareGatewayEnabled(config)).toBe(true);
  config.gateway.sessionControl!.publicationReadEnabled = false;
  expect(sessionShareGatewayEnabled(config)).toBe(false);
  config.gateway.sessionControl!.publicationReadEnabled = true;
  config.plugins!.enabled = false;
  expect(sessionShareGatewayEnabled(config)).toBe(false);
  config.plugins!.enabled = true;
  config.plugins!.entries!["session-share"]!.enabled = false;
  expect(sessionShareGatewayEnabled(config)).toBe(false);
});
