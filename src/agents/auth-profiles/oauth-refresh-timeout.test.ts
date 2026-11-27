import { expect, it } from "vitest";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS } from "./constants.js";

it("allows cold OAuth token exchanges at least 30 seconds before the caller times out", () => {
  // Cold TCP/TLS setup and plugin bootstrap can outlast a typical token exchange.
  expect(OAUTH_REFRESH_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
});
