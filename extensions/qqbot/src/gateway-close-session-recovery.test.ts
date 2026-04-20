import { describe, expect, it } from "vitest";
import { resolveQQBotGatewaySessionRecovery } from "./gateway-close-session-recovery.js";

describe("resolveQQBotGatewaySessionRecovery", () => {
  it("forces re-identify when the gateway reports the session is no longer valid", () => {
    expect(resolveQQBotGatewaySessionRecovery(4006)).toEqual({
      clearSession: true,
      description: "session no longer valid",
      reconnectMode: "identify",
      shouldRefreshToken: true,
    });
  });

  it("forces re-identify when the resume sequence is invalid", () => {
    expect(resolveQQBotGatewaySessionRecovery(4007)).toEqual({
      clearSession: true,
      description: "invalid seq on resume",
      reconnectMode: "identify",
      shouldRefreshToken: true,
    });
  });

  it("keeps the saved session for 4009 so the reconnect path can resume", () => {
    expect(resolveQQBotGatewaySessionRecovery(4009)).toEqual({
      clearSession: false,
      description: "session timed out",
      reconnectMode: "resume",
      shouldRefreshToken: true,
    });
  });

  it("ignores unrelated close codes", () => {
    expect(resolveQQBotGatewaySessionRecovery(4004)).toBeNull();
    expect(resolveQQBotGatewaySessionRecovery(4900)).toBeNull();
  });
});
