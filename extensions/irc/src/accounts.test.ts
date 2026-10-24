// Irc tests cover accounts plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listIrcAccountIds, resolveDefaultIrcAccountId, resolveIrcAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

function asConfig(value: unknown): CoreConfig {
  return value as CoreConfig;
}

describe("listIrcAccountIds", () => {
  it("keeps the implicit default account when named accounts are added to top-level connection config", () => {
    const cfg = asConfig({
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "claw",
          accounts: {
            work: {
              enabled: false,
              host: "irc-work.example.com",
              nick: "claw-work",
            },
          },
        },
      },
    });

    expect(listIrcAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultIrcAccountId(cfg)).toBe("default");
  });
});

describe("resolveIrcAccount", () => {
  let fixtureDirectory: string;
  let fixturePasswordFile: string;

  beforeAll(() => {
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-irc-password-"));
    fixturePasswordFile = path.join(fixtureDirectory, "password.txt");
    fs.writeFileSync(fixturePasswordFile, "file\n", "utf8");
  });

  afterAll(() => fs.rmSync(fixtureDirectory, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { accountId: "default", credential: "password" },
    { accountId: "default", credential: "nickserv" },
  ])(
    "isolates an unavailable $credential SecretRef for $accountId",
    ({ accountId, credential }) => {
      vi.stubEnv("IRC_PASSWORD", "ambient-server-secret");
      vi.stubEnv("IRC_NICKSERV_PASSWORD", "ambient-nickserv-secret");

      const ref = { source: "env", provider: "default", id: "IRC_UNAVAILABLE_EXPLICIT_SECRET" };
      const account = resolveIrcAccount({
        cfg: asConfig({
          channels: {
            irc: {
              accounts: {
                [accountId]: {
                  host: "irc.example.com",
                  nick: "openclaw",
                  ...(credential === "password"
                    ? { password: ref, passwordFile: fixturePasswordFile }
                    : { nickserv: { password: ref, passwordFile: fixturePasswordFile } }),
                },
              },
            },
          },
        }),
        accountId,
      });

      expect(account.configured).toBe(true);
      expect(account.tokenStatus).toBe("configured_unavailable");
      if (credential === "password") {
        expect(account.password).toBe("");
        expect(account.passwordSource).toBe("config");
      } else {
        expect(account.config.nickserv?.password).toBeUndefined();
      }
    },
  );

  it.each<[string, string, string, string, boolean, string]>([
    ["password", "default", "plain", "env", true, "env"],
    ["password", "default", "plain", "", true, "file"],
    ["password", "work", "plain", "env", false, "plain"],
    ["nickserv", "work", "", "env", true, "file"],
  ])(
    "preserves %s precedence for %s (plaintext=%s, env=%s, file=%s => %s)",
    (credential, accountId, plaintext, env, file, expected) => {
      vi.stubEnv(credential === "password" ? "IRC_PASSWORD" : "IRC_NICKSERV_PASSWORD", env);

      const credentialConfig = {
        password: plaintext,
        ...(file ? { passwordFile: fixturePasswordFile } : {}),
      };
      const account = resolveIrcAccount({
        cfg: asConfig({
          channels: {
            irc: {
              accounts: {
                [accountId]: {
                  host: "irc.example.com",
                  nick: "openclaw",
                  ...(credential === "password"
                    ? credentialConfig
                    : { nickserv: credentialConfig }),
                },
              },
            },
          },
        }),
        accountId,
      });

      expect(credential === "password" ? account.password : account.config.nickserv?.password).toBe(
        expected,
      );
      expect(account.tokenStatus).toBe("available");
    },
  );

  it.runIf(process.platform !== "win32")("isolates symlinked password files", () => {
    const passwordLink = path.join(fixtureDirectory, "password-link.txt");
    fs.symlinkSync(fixturePasswordFile, passwordLink);

    const cfg = asConfig({
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "claw",
          passwordFile: passwordLink,
        },
      },
    });

    const account = resolveIrcAccount({ cfg });
    expect(account.password).toBe("");
    expect(account.passwordSource).toBe("passwordFile");
    expect(account.tokenStatus).toBe("configured_unavailable");
    expect(account.credentialDiagnostics).toEqual([
      {
        code: "CREDENTIAL_FILE_UNAVAILABLE",
        path: "channels.irc.accounts.default.passwordFile",
        reason: "symlink",
      },
    ]);
    expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(passwordLink);
  });

  it.runIf(process.platform !== "win32")("isolates symlinked NickServ password files", () => {
    const passwordLink = path.join(fixtureDirectory, "nickserv-password-link.txt");
    fs.symlinkSync(fixturePasswordFile, passwordLink);

    const cfg = asConfig({
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "claw",
          nickserv: {
            passwordFile: passwordLink,
          },
        },
      },
    });

    const account = resolveIrcAccount({ cfg });
    expect(account.config.nickserv?.password).toBeUndefined();
    expect(account.tokenStatus).toBe("configured_unavailable");
    expect(account.credentialDiagnostics).toEqual([
      {
        code: "CREDENTIAL_FILE_UNAVAILABLE",
        path: "channels.irc.accounts.default.nickserv.passwordFile",
        reason: "symlink",
      },
    ]);
    expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(passwordLink);
  });

  it("does not fall through from a missing explicit password file", () => {
    const passwordFile = path.join(fixtureDirectory, "missing-password.txt");
    const account = resolveIrcAccount({
      cfg: asConfig({
        channels: {
          irc: {
            accounts: {
              work: {
                host: "irc.example.com",
                nick: "claw",
                password: "test-password",
                passwordFile,
              },
            },
          },
        },
      }),
      accountId: "work",
    });

    expect(account.password).toBe("");
    expect(account.passwordSource).toBe("passwordFile");
    expect(account.tokenStatus).toBe("configured_unavailable");
    expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(passwordFile);
  });

  it("preserves shared NickServ config when an account overrides one NickServ field", () => {
    const account = resolveIrcAccount({
      cfg: asConfig({
        channels: {
          irc: {
            host: "irc.example.com",
            nick: "claw",
            nickserv: {
              service: "NickServ",
            },
            accounts: {
              work: {
                nickserv: {
                  registerEmail: "work@example.com",
                },
              },
            },
          },
        },
      }),
      accountId: "work",
    });

    expect(account.config.nickserv).toEqual({
      service: "NickServ",
      registerEmail: "work@example.com",
    });
  });
});
