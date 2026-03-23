import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { describe, expect, it } from "vitest";
import { msteamsSetupAdapter } from "./setup-core.js";

describe("msteams setup core", () => {
  it("always resolves to the default account", () => {
    expect(msteamsSetupAdapter.resolveAccountId?.({ accountId: "work" } as never)).toBe(
      DEFAULT_ACCOUNT_ID,
    );
  });

  it("enables the msteams channel without dropping existing config", () => {
    expect(
      msteamsSetupAdapter.applyAccountConfig?.({
        cfg: {
          channels: {
            msteams: {
              appId: "existing-app",
            },
          },
        },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {},
      } as never),
    ).toEqual({
      channels: {
        msteams: {
          appId: "existing-app",
          enabled: true,
        },
      },
    });
  });
});
