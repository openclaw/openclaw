// Qqbot tests cover resolve plugin behavior.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  listAccountIds,
  resolveDefaultAccountId,
  resolveAccountBase,
} from "./resolve.js";

describe("engine/config/resolve", () => {
  it("returns empty list when no accounts configured", () => {
    expect(listAccountIds({})).toStrictEqual([]);
  });

  it("returns default when top-level appId is set", () => {
    const cfg = {
      channels: {
        qqbot: { appId: "123456" },
      },
    };
    expect(listAccountIds(cfg)).toEqual([DEFAULT_ACCOUNT_ID]);
  });

  it("lists named accounts", () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            bot2: { appId: "654321" },
            bot3: { appId: "111222" },
          },
        },
      },
    };
    const ids = listAccountIds(cfg);
    expect(ids).toContain("bot2");
    expect(ids).toContain("bot3");
  });

  it("ignores inherited appId on a named account when listing IDs", () => {
    const account = Object.assign(
      Object.create({ appId: "inherited-app-id" }) as Record<string, unknown>,
      { name: "Owned Bot" },
    );
    const cfg = {
      channels: {
        qqbot: {
          accounts: { bot2: account },
        },
      },
    };

    expect(listAccountIds(cfg)).toStrictEqual([]);
  });

  it("resolves default account id to 'default' when top-level appId exists", () => {
    const cfg = {
      channels: {
        qqbot: { appId: "123456" },
      },
    };
    expect(resolveDefaultAccountId(cfg)).toBe(DEFAULT_ACCOUNT_ID);
  });

  it("honors configured defaultAccount", () => {
    const cfg = {
      channels: {
        qqbot: {
          defaultAccount: "bot2",
          accounts: {
            bot2: { appId: "654321" },
          },
        },
      },
    };
    expect(resolveDefaultAccountId(cfg)).toBe("bot2");
  });

  it("falls back to first named account when no default configured", () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            mybot: { appId: "999999" },
          },
        },
      },
    };
    expect(resolveDefaultAccountId(cfg)).toBe("mybot");
  });

  it("resolves base account info for default account", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          name: "Test Bot",
          systemPrompt: "You are helpful.",
          markdownSupport: true,
        },
      },
    };
    const base = resolveAccountBase(cfg, DEFAULT_ACCOUNT_ID);
    expect(base.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(base.appId).toBe("123456");
    expect(base.name).toBe("Test Bot");
    expect(base.systemPrompt).toBe("You are helpful.");
    expect(base.markdownSupport).toBe(true);
    expect(base.enabled).toBe(true);
  });

  it("merges accounts.default into the default account config", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          name: "Top Bot",
          groups: { G1: { commandLevel: "all" } },
          accounts: {
            default: {
              appId: "654321",
              name: "Default Bot",
              groups: { G1: { commandLevel: "safety" } },
            },
          },
        },
      },
    };

    const base = resolveAccountBase(cfg, DEFAULT_ACCOUNT_ID);

    expect(base.name).toBe("Default Bot");
    expect(base.appId).toBe("654321");
    expect(base.config.groups).toEqual({ G1: { commandLevel: "safety" } });
  });

  it("resolves base account info for named account", () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            bot2: {
              appId: "654321",
              name: "Bot Two",
              enabled: false,
            },
          },
        },
      },
    };
    const base = resolveAccountBase(cfg, "bot2");
    expect(base.accountId).toBe("bot2");
    expect(base.appId).toBe("654321");
    expect(base.name).toBe("Bot Two");
    expect(base.enabled).toBe(false);
  });

  it("ignores inherited fields on an own named account entry", () => {
    const account = Object.assign(
      Object.create({
        appId: "inherited-app-id",
        clientSecret: "placeholder",
        clientSecretFile: "/tmp/placeholder",
      }) as Record<string, unknown>,
      { name: "Owned Bot", enabled: false },
    );
    const cfg = {
      channels: {
        qqbot: {
          accounts: { bot2: account },
        },
      },
    };

    const base = resolveAccountBase(cfg, "bot2");

    expect(account.appId).toBe("inherited-app-id");
    expect(base.appId).toBe("");
    expect(base.name).toBe("Owned Bot");
    expect(base.enabled).toBe(false);
    expect(base.config).toEqual({ name: "Owned Bot", enabled: false });
    expect(base.config.clientSecret).toBeUndefined();
    expect(base.config.clientSecretFile).toBeUndefined();
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg = {
      channels: {
        qqbot: {
          defaultAccount: "bot2",
          accounts: {
            bot2: { appId: "654321" },
          },
        },
      },
    };
    const base = resolveAccountBase(cfg);
    expect(base.accountId).toBe("bot2");
    expect(base.appId).toBe("654321");
  });

  it("preserves audioFormatPolicy on the config object", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          audioFormatPolicy: {
            sttDirectFormats: [".wav"],
            uploadDirectFormats: [".mp3"],
            transcodeEnabled: false,
          },
        },
      },
    };
    const base = resolveAccountBase(cfg, DEFAULT_ACCOUNT_ID);
    expect(base.config.audioFormatPolicy).toEqual({
      sttDirectFormats: [".wav"],
      uploadDirectFormats: [".mp3"],
      transcodeEnabled: false,
    });
  });
});
