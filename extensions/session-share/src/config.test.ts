import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it } from "vitest";
import { sessionShareGatewaySourceEnabled } from "./config.js";

it("requires explicit source publication opt-in independently of host request admission", () => {
  const share: { gateway?: boolean } = {};
  const config: OpenClawConfig = {
    plugins: {
      entries: { "session-share": { enabled: true, config: { share } } },
    },
  };
  expect(sessionShareGatewaySourceEnabled(config)).toBe(false);
  share.gateway = false;
  expect(sessionShareGatewaySourceEnabled(config)).toBe(false);
  share.gateway = true;
  expect(sessionShareGatewaySourceEnabled(config)).toBe(true);
  config.plugins!.enabled = false;
  expect(sessionShareGatewaySourceEnabled(config)).toBe(false);
  config.plugins!.enabled = true;
  config.plugins!.entries!["session-share"]!.enabled = false;
  expect(sessionShareGatewaySourceEnabled(config)).toBe(false);
});
