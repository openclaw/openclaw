import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it, vi } from "vitest";
import { A2aPeerAuthorizationError, captureA2aPeerAuthorization } from "./peer-authorization.js";

it.each(["peer removed", "account removed", "disabled", "rotated", "stopped", "unavailable"])(
  "retires the captured peer credential after %s",
  (change) => {
    let config: OpenClawConfig = {
      channels: { a2a: { peers: { alpha: { token: "original-token" } } } },
    };
    let available = true;
    const controller = new AbortController();
    const readConfig = () => {
      if (!available) {
        throw new Error("runtime snapshot owner unavailable");
      }
      return config;
    };
    const authorization = captureA2aPeerAuthorization({
      authorization: "Bearer original-token",
      accountId: "default",
      readConfig,
      signal: controller.signal,
    });
    expect(authorization?.peerName).toBe("alpha");
    expect(authorization?.isCurrent()).toBe(true);
    expect(authorization!.assertCurrent).not.toThrow();
    if (change === "peer removed") {
      config = { channels: { a2a: { peers: {} } } };
    } else if (change === "account removed") {
      config = {};
    } else if (change === "disabled") {
      config.channels!.a2a!.enabled = false;
    } else if (change === "rotated") {
      config.channels!.a2a!.peers!.alpha!.token = "replacement-token";
    } else if (change === "stopped") {
      controller.abort();
    } else {
      available = false;
    }
    expect(authorization?.isCurrent()).toBe(false);
    expect(authorization!.assertCurrent).toThrow(A2aPeerAuthorizationError);
    expect(
      captureA2aPeerAuthorization({
        authorization: "Bearer original-token",
        accountId: "default",
        readConfig,
        signal: controller.signal,
      }),
    ).toBeUndefined();
  },
);

it("does not lend the default account credential to another account", () => {
  const readConfig = vi.fn(() => ({
    channels: { a2a: { peers: { alpha: { token: "original-token" } } } },
  }));
  expect(
    captureA2aPeerAuthorization({
      authorization: "Bearer original-token",
      accountId: "other",
      readConfig,
      signal: new AbortController().signal,
    }),
  ).toBeUndefined();
  expect(readConfig).not.toHaveBeenCalled();
});
