import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { listEnabledBlueBubblesAccounts, resolveBlueBubblesAccount } from "./accounts.js";

describe("resolveBlueBubblesAccount", () => {
  it("requires explicit top-level enabled true for the default account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        bluebubbles: {
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      },
    };

    const account = resolveBlueBubblesAccount({ cfg });

    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(false);
  });

  it("enables the default account when the channel explicitly opts in", () => {
    const cfg: OpenClawConfig = {
      channels: {
        bluebubbles: {
          enabled: true,
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      },
    };

    const account = resolveBlueBubblesAccount({ cfg });

    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(true);
  });

  it("keeps an explicitly disabled default account disabled", () => {
    const cfg: OpenClawConfig = {
      channels: {
        bluebubbles: {
          enabled: false,
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      },
    };

    const account = resolveBlueBubblesAccount({ cfg });

    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(false);
  });

  it("requires explicit account opt-in for configured account entries", () => {
    const cfg: OpenClawConfig = {
      channels: {
        bluebubbles: {
          enabled: true,
          accounts: {
            personal: {
              serverUrl: "http://localhost:1234",
              password: "test-password",
            },
          },
        },
      },
    };

    const account = resolveBlueBubblesAccount({ cfg, accountId: "personal" });

    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(false);
  });

  it("enables account entries only when both channel and account opt in", () => {
    const cfg: OpenClawConfig = {
      channels: {
        bluebubbles: {
          enabled: true,
          accounts: {
            personal: {
              enabled: true,
              serverUrl: "http://localhost:1234",
              password: "test-password",
            },
          },
        },
      },
    };

    const account = resolveBlueBubblesAccount({ cfg, accountId: "personal" });

    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(true);
  });

  it("does not enable an opted-in account when the channel is not opted in", () => {
    const cfg: OpenClawConfig = {
      channels: {
        bluebubbles: {
          accounts: {
            personal: {
              enabled: true,
              serverUrl: "http://localhost:1234",
              password: "test-password",
            },
          },
        },
      },
    };

    const account = resolveBlueBubblesAccount({ cfg, accountId: "personal" });

    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(false);
  });
});

describe("listEnabledBlueBubblesAccounts", () => {
  it("returns only accounts with explicit channel and account opt-in", () => {
    const cfg: OpenClawConfig = {
      channels: {
        bluebubbles: {
          enabled: true,
          accounts: {
            disabled: {
              serverUrl: "http://localhost:1234",
              password: "disabled-password",
            },
            enabled: {
              enabled: true,
              serverUrl: "http://localhost:5678",
              password: "enabled-password",
            },
          },
        },
      },
    };

    const accounts = listEnabledBlueBubblesAccounts(cfg);

    expect(accounts.map((account) => account.accountId)).toEqual(["enabled"]);
  });
});
