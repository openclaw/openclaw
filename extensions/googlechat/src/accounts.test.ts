import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { describe, expect, it } from "vitest";
import { listGoogleChatAccountIds, resolveGoogleChatAccount } from "./accounts.js";

describe("googlechat accounts null-safety", () => {
  it("does not throw when channels.googlechat is null", () => {
    const cfg = {
      channels: {
        googlechat: null,
      },
    } as unknown as OpenClawConfig;

    expect(listGoogleChatAccountIds(cfg)).toEqual([DEFAULT_ACCOUNT_ID]);
    expect(() => resolveGoogleChatAccount({ cfg })).not.toThrow();

    const account = resolveGoogleChatAccount({ cfg });
    expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(account.credentialSource).toBe("none");
  });
});
