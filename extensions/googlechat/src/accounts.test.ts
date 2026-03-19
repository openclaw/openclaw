import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveGoogleChatAccount } from "./accounts.js";

describe("resolveGoogleChatAccount", () => {
  it("inherits shared defaults from accounts.default for named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
              webhookPath: "/googlechat",
            },
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "andy" });
    expect(resolved.config.audienceType).toBe("app-url");
    expect(resolved.config.audience).toBe("https://example.com/googlechat");
    expect(resolved.config.webhookPath).toBe("/googlechat");
    expect(resolved.config.serviceAccountFile).toBe("/tmp/andy-sa.json");
  });

  it("prefers top-level and account overrides over accounts.default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          audienceType: "project-number",
          audience: "1234567890",
          accounts: {
            default: {
              audienceType: "app-url",
              audience: "https://default.example.com/googlechat",
              webhookPath: "/googlechat-default",
            },
            april: {
              webhookPath: "/googlechat-april",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "april" });
    expect(resolved.config.audienceType).toBe("project-number");
    expect(resolved.config.audience).toBe("1234567890");
    expect(resolved.config.webhookPath).toBe("/googlechat-april");
  });

  it("does not inherit disabled state from accounts.default for named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              enabled: false,
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
            },
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "andy" });
    expect(resolved.enabled).toBe(true);
    expect(resolved.config.enabled).toBeUndefined();
    expect(resolved.config.audienceType).toBe("app-url");
  });

  it("does not inherit default-account credentials into named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              serviceAccountRef: {
                source: "env",
                provider: "test",
                id: "default-sa",
              },
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
            },
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "andy" });
    expect(resolved.credentialSource).toBe("file");
    expect(resolved.credentialsFile).toBe("/tmp/andy-sa.json");
    expect(resolved.config.audienceType).toBe("app-url");
  });

  it("does not inherit dangerous name matching from accounts.default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              dangerouslyAllowNameMatching: true,
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
            },
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "andy" });
    expect(resolved.config.dangerouslyAllowNameMatching).toBeUndefined();
    expect(resolved.config.audienceType).toBe("app-url");
  });
});
