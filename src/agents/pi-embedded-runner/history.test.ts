import { describe, expect, it } from "vitest";
import { getHistoryLimitFromSessionKey } from "./history.js";

describe("getHistoryLimitFromSessionKey", () => {
  it("matches channel history limits across canonical provider aliases", () => {
    expect(
      getHistoryLimitFromSessionKey("agent:main:z-ai:channel:general", {
        channels: {
          "z.ai": {
            historyLimit: 17,
          },
        },
      }),
    ).toBe(17);
  });

  it("prefers Telegram topic history limits over group and account defaults", () => {
    expect(
      getHistoryLimitFromSessionKey("agent:main:telegram:group:-1001234567890:topic:42", {
        channels: {
          telegram: {
            historyLimit: 50,
            groups: {
              "-1001234567890": {
                historyLimit: 12,
                topics: {
                  "42": { historyLimit: 4 },
                },
              },
            },
          },
        },
      }),
    ).toBe(4);
  });

  it("falls back to Telegram group history limits for topic sessions", () => {
    expect(
      getHistoryLimitFromSessionKey("agent:main:telegram:group:-1001234567890:topic:42", {
        channels: {
          telegram: {
            historyLimit: 50,
            groups: {
              "-1001234567890": {
                historyLimit: 12,
              },
            },
          },
        },
      }),
    ).toBe(12);
  });
});
