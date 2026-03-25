import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { listTlonAccountIds, resolveTlonAccount } from "./types.js";

describe("tlon account helpers", () => {
  it("lists named accounts and the implicit default account", () => {
    const cfg = {
      channels: {
        tlon: {
          ship: "~zod",
          accounts: {
            Work: { ship: "~bus" },
            alerts: { ship: "~nec" },
          },
        },
      },
    } as OpenClawConfig;

    expect(listTlonAccountIds(cfg)).toEqual(["alerts", "default", "work"]);
  });

  it("merges named account config over channel defaults", () => {
    const resolved = resolveTlonAccount(
      {
        channels: {
          tlon: {
            name: "Base",
            ship: "~zod",
            url: "https://urbit.example.com",
            code: "base-code",
            dmAllowlist: ["~nec"],
            groupInviteAllowlist: ["~bus"],
            defaultAuthorizedShips: ["~marzod"],
            accounts: {
              Work: {
                name: "Work",
                code: "work-code",
                dmAllowlist: ["~rovnys"],
              },
            },
          },
        },
      } as OpenClawConfig,
      "work",
    );

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.ship).toBe("~zod");
    expect(resolved.url).toBe("https://urbit.example.com");
    expect(resolved.code).toBe("work-code");
    expect(resolved.dmAllowlist).toEqual(["~rovnys"]);
    expect(resolved.groupInviteAllowlist).toEqual(["~bus"]);
    expect(resolved.defaultAuthorizedShips).toEqual(["~marzod"]);
    expect(resolved.configured).toBe(true);
  });

  it("keeps the default account on channel-level config only", () => {
    const resolved = resolveTlonAccount(
      {
        channels: {
          tlon: {
            ship: "~zod",
            url: "https://urbit.example.com",
            code: "base-code",
            accounts: {
              default: {
                ship: "~ignored",
                code: "ignored-code",
              },
            },
          },
        },
      } as OpenClawConfig,
      "default",
    );

    expect(resolved.ship).toBe("~zod");
    expect(resolved.code).toBe("base-code");
  });
});
