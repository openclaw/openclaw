import { describe, expect, it } from "vitest";
import { listSaintEmailAccountIds, resolveSaintEmailAccount } from "./accounts.js";

describe("saint-email accounts", () => {
  it("resolves default account from top-level config", () => {
    const cfg = {
      channels: {
        email: {
          address: "bot@example.com",
          accessToken: "token",
          allowFrom: ["owner@example.com"],
        },
      },
    } as const;

    const account = resolveSaintEmailAccount({ cfg, accountId: "default" });
    expect(account.address).toBe("bot@example.com");
    expect(account.allowFrom).toEqual(["owner@example.com"]);
  });

  it("lists account ids from account map", () => {
    const cfg = {
      channels: {
        email: {
          accounts: {
            sales: { address: "sales@example.com" },
            support: { address: "support@example.com" },
          },
        },
      },
    } as const;

    const ids = listSaintEmailAccountIds(cfg);
    expect(ids).toEqual(["sales", "support"]);
  });

  it("resolves push verification token with account override", () => {
    const cfg = {
      channels: {
        email: {
          pushVerificationToken: "global-token",
          accounts: {
            sales: { address: "sales@example.com", pushVerificationToken: "sales-token" },
          },
        },
      },
    } as const;

    const sales = resolveSaintEmailAccount({ cfg, accountId: "sales" });
    const fallback = resolveSaintEmailAccount({ cfg, accountId: "support" });
    expect(sales.pushVerificationToken).toBe("sales-token");
    expect(fallback.pushVerificationToken).toBe("global-token");
  });

  it("resolves oauth2 config with account-level overrides", () => {
    const cfg = {
      channels: {
        email: {
          address: "bot@example.com",
          oauth2: {
            serviceAccountEmail: "svc@example.iam.gserviceaccount.com",
            privateKey: "-----BEGIN PRIVATE KEY-----\\nBASE\\n-----END PRIVATE KEY-----",
            scopes: ["https://www.googleapis.com/auth/gmail.send"],
          },
          accounts: {
            support: {
              address: "support@example.com",
              oauth2: {
                subject: "support@example.com",
              },
            },
          },
        },
      },
    } as const;

    const account = resolveSaintEmailAccount({ cfg, accountId: "support" });
    expect(account.oauth2?.serviceAccountEmail).toBe("svc@example.iam.gserviceaccount.com");
    expect(account.oauth2?.subject).toBe("support@example.com");
    expect(account.oauth2?.scopes).toEqual(["https://www.googleapis.com/auth/gmail.send"]);
  });
});
