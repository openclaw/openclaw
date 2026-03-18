import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { resolveNapCatAccount } from "./accounts.js";

describe("resolveNapCatAccount", () => {
  it("normalizes webhook path to leading slash", () => {
    const account = resolveNapCatAccount({
      cfg: {
        channels: {
          napcat: {
            token: "token",
            apiBaseUrl: "http://127.0.0.1:3000",
            transport: {
              http: {
                path: "onebot",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(account.transport.http.path).toBe("/onebot");
  });
});
