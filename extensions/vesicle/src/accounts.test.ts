import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import { resolveVesicleAccount, resolveVesicleServerAccount } from "./accounts.js";

describe("Vesicle accounts", () => {
  it("marks accounts configured when serverUrl and authToken are present", () => {
    const cfg = {
      channels: {
        vesicle: {
          serverUrl: "127.0.0.1:1234/",
          authToken: "token",
        },
      },
    } as OpenClawConfig;
    const account = resolveVesicleAccount({ cfg });
    expect(account.configured).toBe(true);
    expect(account.baseUrl).toBe("http://127.0.0.1:1234");
  });

  it("merges per-account overrides", () => {
    const cfg = {
      channels: {
        vesicle: {
          serverUrl: "http://base.local",
          authToken: "base-token",
          accounts: {
            work: {
              serverUrl: "http://work.local",
            },
          },
        },
      },
    } as OpenClawConfig;
    const account = resolveVesicleServerAccount({ cfg, accountId: "work" });
    expect(account.baseUrl).toBe("http://work.local");
    expect(account.authToken).toBe("base-token");
  });
});
