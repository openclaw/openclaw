import { describe, it, expect } from "vitest";
import type { CoreConfig } from "./types.js";
import { resolveAniAccount } from "./channel.js";

describe("resolveAniAccount", () => {
  it("resolves a fully configured account", () => {
    const cfg: CoreConfig = {
      channels: {
        ani: {
          serverUrl: "https://your-ani-server.example.com",
          apiKey: "aim_abc123",
          entityId: 42,
          enabled: true,
          name: "My Bot",
        },
      },
    };
    const result = resolveAniAccount({ cfg });
    expect(result.configured).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.serverUrl).toBe("https://your-ani-server.example.com");
    expect(result.entityId).toBe(42);
    expect(result.name).toBe("My Bot");
    expect(result.accountId).toBe("default");
  });

  it("strips trailing slashes from serverUrl", () => {
    const cfg: CoreConfig = {
      channels: {
        ani: {
          serverUrl: "https://your-ani-server.example.com///",
          apiKey: "aim_abc123",
        },
      },
    };
    const result = resolveAniAccount({ cfg });
    expect(result.serverUrl).toBe("https://your-ani-server.example.com");
    expect(result.configured).toBe(true);
  });

  it("marks as not configured when serverUrl is missing", () => {
    const cfg: CoreConfig = {
      channels: {
        ani: {
          apiKey: "aim_abc123",
        },
      },
    };
    const result = resolveAniAccount({ cfg });
    expect(result.configured).toBe(false);
    expect(result.serverUrl).toBeUndefined();
  });

  it("marks as not configured when apiKey is missing", () => {
    const cfg: CoreConfig = {
      channels: {
        ani: {
          serverUrl: "https://your-ani-server.example.com",
        },
      },
    };
    const result = resolveAniAccount({ cfg });
    expect(result.configured).toBe(false);
  });

  it("rejects bootstrap keys (aimb_ prefix)", () => {
    const cfg: CoreConfig = {
      channels: {
        ani: {
          serverUrl: "https://your-ani-server.example.com",
          apiKey: "aimb_bootstrap_key_123",
        },
      },
    };
    const result = resolveAniAccount({ cfg });
    expect(result.configured).toBe(false);
  });

  it("defaults enabled to true when not specified", () => {
    const cfg: CoreConfig = {
      channels: {
        ani: {
          serverUrl: "https://your-ani-server.example.com",
          apiKey: "aim_abc123",
        },
      },
    };
    const result = resolveAniAccount({ cfg });
    expect(result.enabled).toBe(true);
  });

  it("respects enabled: false", () => {
    const cfg: CoreConfig = {
      channels: {
        ani: {
          serverUrl: "https://your-ani-server.example.com",
          apiKey: "aim_abc123",
          enabled: false,
        },
      },
    };
    const result = resolveAniAccount({ cfg });
    expect(result.enabled).toBe(false);
  });

  it("handles missing channels.ani gracefully", () => {
    const cfg: CoreConfig = {};
    const result = resolveAniAccount({ cfg });
    expect(result.configured).toBe(false);
    expect(result.enabled).toBe(true); // default
    expect(result.serverUrl).toBeUndefined();
  });

  it("normalizes accountId from params", () => {
    const cfg: CoreConfig = {
      channels: {
        ani: {
          serverUrl: "https://agent-native.im",
          apiKey: "aim_abc123",
        },
      },
    };
    const result = resolveAniAccount({ cfg, accountId: "custom" });
    expect(result.accountId).toBe("custom");
  });
});
