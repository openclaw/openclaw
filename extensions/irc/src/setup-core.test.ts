import { describe, expect, it } from "vitest";
import {
  ircSetupAdapter,
  parsePort,
  setIrcAllowFrom,
  setIrcDmPolicy,
  setIrcGroupAccess,
  setIrcNickServ,
  updateIrcAccountConfig,
} from "./setup-core.js";
import type { CoreConfig } from "./types.js";

describe("irc setup core", () => {
  it("parses valid ports and falls back for invalid values", () => {
    expect(parsePort("6697", 6667)).toBe(6697);
    expect(parsePort(" 7000 ", 6667)).toBe(7000);
    expect(parsePort("", 6667)).toBe(6667);
    expect(parsePort("70000", 6667)).toBe(6667);
    expect(parsePort("abc", 6667)).toBe(6667);
  });

  it("updates top-level dm policy and allowlist", () => {
    const cfg: CoreConfig = { channels: { irc: {} } };

    expect(setIrcDmPolicy(cfg, "open")).toMatchObject({
      channels: {
        irc: {
          dmPolicy: "open",
        },
      },
    });

    expect(setIrcAllowFrom(cfg, ["alice", "bob"])).toMatchObject({
      channels: {
        irc: {
          allowFrom: ["alice", "bob"],
        },
      },
    });
  });

  it("stores nickserv and account config patches on the scoped account", () => {
    const cfg: CoreConfig = { channels: { irc: {} } };

    expect(
      setIrcNickServ(cfg, "work", {
        enabled: true,
        service: "NickServ",
      }),
    ).toMatchObject({
      channels: {
        irc: {
          accounts: {
            work: {
              nickserv: {
                enabled: true,
                service: "NickServ",
              },
            },
          },
        },
      },
    });

    expect(
      updateIrcAccountConfig(cfg, "work", {
        host: "irc.libera.chat",
        nick: "openclaw-work",
      }),
    ).toMatchObject({
      channels: {
        irc: {
          accounts: {
            work: {
              host: "irc.libera.chat",
              nick: "openclaw-work",
            },
          },
        },
      },
    });
  });

  it("normalizes allowlist groups and handles non-allowlist policies", () => {
    const cfg: CoreConfig = { channels: { irc: {} } };

    expect(
      setIrcGroupAccess(
        cfg,
        "default",
        "allowlist",
        ["openclaw", "#ops", "openclaw", "*"],
        (raw) => {
          const trimmed = raw.trim();
          if (!trimmed) {
            return null;
          }
          if (trimmed === "*") {
            return "*";
          }
          return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
        },
      ),
    ).toMatchObject({
      channels: {
        irc: {
          enabled: true,
          groupPolicy: "allowlist",
          groups: {
            "#openclaw": {},
            "#ops": {},
            "*": {},
          },
        },
      },
    });

    expect(setIrcGroupAccess(cfg, "default", "disabled", [], () => null)).toMatchObject({
      channels: {
        irc: {
          enabled: true,
          groupPolicy: "disabled",
        },
      },
    });
  });

  it("validates required input and applies normalized account config", () => {
    expect(
      ircSetupAdapter.validateInput({
        input: { host: "", nick: "openclaw" },
      } as never),
    ).toBe("IRC requires host.");

    expect(
      ircSetupAdapter.validateInput({
        input: { host: "irc.libera.chat", nick: "" },
      } as never),
    ).toBe("IRC requires nick.");

    expect(
      ircSetupAdapter.validateInput({
        input: { host: "irc.libera.chat", nick: "openclaw" },
      } as never),
    ).toBeNull();

    expect(
      ircSetupAdapter.applyAccountConfig({
        cfg: { channels: { irc: {} } },
        accountId: "default",
        input: {
          name: "Default",
          host: " irc.libera.chat ",
          port: "7000",
          tls: true,
          nick: " openclaw ",
          username: " claw ",
          realname: " OpenClaw Bot ",
          password: " secret ",
          channels: ["#openclaw"],
        },
      } as never),
    ).toEqual({
      channels: {
        irc: {
          enabled: true,
          name: "Default",
          host: "irc.libera.chat",
          port: 7000,
          tls: true,
          nick: "openclaw",
          username: "claw",
          realname: "OpenClaw Bot",
          password: "secret",
          channels: ["#openclaw"],
        },
      },
    });
  });
});
