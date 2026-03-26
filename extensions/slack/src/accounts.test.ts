import { describe, expect, it } from "vitest";
import { mergeSlackAccountConfig, resolveSlackAccount } from "./accounts.js";

describe("mergeSlackAccountConfig thread deep merge", () => {
  it("deep-merges account thread overrides into global thread config", () => {
    const merged = mergeSlackAccountConfig(
      {
        channels: {
          slack: {
            thread: { autoReplyOnParticipation: false, historyScope: "thread" },
            accounts: {
              work: { thread: { historyScope: "channel" } },
            },
          },
        },
      } as never,
      "work",
    );

    expect(merged.thread).toEqual({
      autoReplyOnParticipation: false,
      historyScope: "channel",
    });
  });

  it("preserves global thread config when account has no thread override", () => {
    const merged = mergeSlackAccountConfig(
      {
        channels: {
          slack: {
            thread: { autoReplyOnParticipation: false },
            accounts: {
              work: { requireMention: true },
            },
          },
        },
      } as never,
      "work",
    );

    expect(merged.thread).toEqual({ autoReplyOnParticipation: false });
  });
});

describe("resolveSlackAccount allowFrom precedence", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            defaultAccount: "work",
            accounts: {
              work: {
                name: "Work",
                botToken: "xoxb-work",
                appToken: "xapp-work",
              },
            },
          },
        },
      },
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.botToken).toBe("xoxb-work");
    expect(resolved.appToken).toBe("xapp-work");
  });

  it("prefers accounts.default.allowFrom over top-level for default account", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            allowFrom: ["top"],
            accounts: {
              default: {
                botToken: "xoxb-default",
                appToken: "xapp-default",
                allowFrom: ["default"],
              },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(resolved.config.allowFrom).toEqual(["default"]);
  });

  it("falls back to top-level allowFrom for named account without override", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            allowFrom: ["top"],
            accounts: {
              work: { botToken: "xoxb-work", appToken: "xapp-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toEqual(["top"]);
  });

  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                botToken: "xoxb-default",
                appToken: "xapp-default",
                allowFrom: ["default"],
              },
              work: { botToken: "xoxb-work", appToken: "xapp-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
  });

  it("falls back to top-level dm.allowFrom when allowFrom alias is unset", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            dm: { allowFrom: ["U123"] },
            accounts: {
              work: { botToken: "xoxb-work", appToken: "xapp-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
    expect(resolved.config.dm?.allowFrom).toEqual(["U123"]);
  });
});
