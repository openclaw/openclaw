import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createPluginSetupWizardAdapter,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  promptSetupWizardAllowFrom,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listIrcAccountIds, resolveDefaultIrcAccountId, resolveIrcAccount } from "./accounts.js";
import { ircPlugin } from "./channel.js";
import {
  ircSetupAdapter,
  setIrcGroupAccess,
  setIrcNickServ,
  updateIrcAccountConfig,
} from "./setup-core.js";
import { ircSetupWizard } from "./setup-surface.js";
import type { CoreConfig, IrcAccountConfig } from "./types.js";

const hoisted = vi.hoisted(() => ({ monitorIrcProvider: vi.fn() }));

// mock-isolation: setup tests must not start the real IRC transport.
vi.mock("./channel-runtime.js", () => ({ monitorIrcProvider: hoisted.monitorIrcProvider }));

afterAll(() => {
  vi.doUnmock("./channel-runtime.js");
  vi.resetModules();
});

const ircSetupPlugin = {
  id: "irc",
  meta: { label: "IRC" },
  config: {
    defaultAccountId: resolveDefaultIrcAccountId,
    listAccountIds: listIrcAccountIds,
  },
  setupWizard: ircSetupWizard,
} as never;

const ircConfigureAdapter = createPluginSetupWizardAdapter(ircSetupPlugin);
const ircStatus = createPluginSetupWizardStatus(ircSetupPlugin);

function ircConfig(irc: NonNullable<NonNullable<CoreConfig["channels"]>["irc"]>): CoreConfig {
  return { channels: { irc } };
}

function resolveAccount(config: Partial<IrcAccountConfig>, accountId = "default") {
  return resolveIrcAccount({
    cfg: ircConfig({
      accounts: { [accountId]: { host: "irc.example.com", nick: "claw", ...config } },
    }),
    accountId,
  });
}

describe("listIrcAccountIds", () => {
  it("keeps the implicit default account when named accounts are added to top-level connection config", () => {
    const cfg = ircConfig({
      host: "irc.example.com",
      nick: "claw",
      accounts: {
        work: { enabled: false, host: "irc-work.example.com", nick: "claw-work" },
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

      const ref = {
        source: "env" as const,
        provider: "default",
        id: "IRC_UNAVAILABLE_EXPLICIT_SECRET",
      };
      const account = resolveAccount(
        credential === "password"
          ? { password: ref, passwordFile: fixturePasswordFile }
          : { nickserv: { password: ref, passwordFile: fixturePasswordFile } },
        accountId,
      );

      expect(account).toMatchObject({ configured: true, tokenStatus: "configured_unavailable" });
      if (credential === "password") {
        expect(account).toMatchObject({ password: "", passwordSource: "config" });
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
      const account = resolveAccount(
        credential === "password" ? credentialConfig : { nickserv: credentialConfig },
        accountId,
      );

      expect(credential === "password" ? account.password : account.config.nickserv?.password).toBe(
        expected,
      );
      expect(account.tokenStatus).toBe("available");
    },
  );

  it.runIf(process.platform !== "win32").each(["password", "nickserv"])(
    "isolates symlinked %s files",
    (credential) => {
      const passwordLink = path.join(fixtureDirectory, `${credential}-link.txt`);
      fs.symlinkSync(fixturePasswordFile, passwordLink);
      const account = resolveIrcAccount({
        cfg: ircConfig({
          host: "irc.example.com",
          nick: "claw",
          ...(credential === "password"
            ? { passwordFile: passwordLink }
            : { nickserv: { passwordFile: passwordLink } }),
        }),
      });
      expect(account.tokenStatus).toBe("configured_unavailable");
      if (credential === "password") {
        expect(account).toMatchObject({ password: "", passwordSource: "passwordFile" });
      } else {
        expect(account.config.nickserv?.password).toBeUndefined();
      }
      expect(account.credentialDiagnostics).toEqual([
        {
          code: "CREDENTIAL_FILE_UNAVAILABLE",
          path: `channels.irc.accounts.default.${credential === "password" ? "" : "nickserv."}passwordFile`,
          reason: "symlink",
        },
      ]);
      expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(passwordLink);
    },
  );

  it("does not fall through from a missing explicit password file", () => {
    const passwordFile = path.join(fixtureDirectory, "missing-password.txt");
    const account = resolveAccount({ password: "test-password", passwordFile }, "work");

    expect(account).toMatchObject({
      password: "",
      passwordSource: "passwordFile",
      tokenStatus: "configured_unavailable",
    });
    expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(passwordFile);
  });

  it("preserves shared NickServ config when an account overrides one NickServ field", () => {
    const account = resolveIrcAccount({
      cfg: ircConfig({
        host: "irc.example.com",
        nick: "claw",
        nickserv: { service: "NickServ" },
        accounts: { work: { nickserv: { registerEmail: "work@example.com" } } },
      }),
      accountId: "work",
    });

    expect(account.config.nickserv).toEqual({
      service: "NickServ",
      registerEmail: "work@example.com",
    });
  });
});

function expectIrcConfig(actual: CoreConfig, irc: Parameters<typeof ircConfig>[0]) {
  expect(actual).toStrictEqual(ircConfig(irc));
}

function makePrompter(answers: Record<string, string>, yes: string[] = []) {
  return createTestWizardPrompter({
    text: vi.fn(async ({ message }: { message: string }) => {
      const answer = Object.entries(answers).find(([key]) =>
        key.endsWith("*") ? message.startsWith(key.slice(0, -1)) : message === key,
      )?.[1];
      if (answer === undefined) {
        throw new Error(`Unexpected prompt: ${message}`);
      }
      return answer;
    }) as WizardPrompter["text"],
    confirm: vi.fn(async ({ message }: { message: string }) => yes.includes(message)),
  });
}

describe("irc setup", () => {
  afterEach(() => vi.clearAllMocks());

  it("setup status honors the configured default account", async () => {
    const status = await ircStatus({
      cfg: ircConfig({
        defaultAccount: "work",
        accounts: {
          ops: { host: "irc.example.com", nick: "ops-bot" },
          work: { host: "irc.example.com", nick: "" },
        },
      }),
      accountOverrides: {},
    });

    expect(status).toMatchObject({ configured: false, statusLines: ["IRC: needs host + nick"] });
  });

  it("stores nickserv and account config patches on the scoped account", () => {
    const cfg: CoreConfig = ircConfig({});

    expectIrcConfig(setIrcNickServ(cfg, "work", { enabled: true, service: "NickServ" }), {
      accounts: { work: { nickserv: { enabled: true, service: "NickServ" } } },
    });

    expectIrcConfig(
      updateIrcAccountConfig(cfg, "work", {
        host: "irc.libera.chat",
        nick: "openclaw-work",
      }),
      { accounts: { work: { host: "irc.libera.chat", nick: "openclaw-work" } } },
    );
  });

  it("normalizes allowlist groups and handles non-allowlist policies", () => {
    const cfg: CoreConfig = ircConfig({});

    expectIrcConfig(
      setIrcGroupAccess(
        cfg,
        "default",
        "allowlist",
        ["openclaw", "#ops", "openclaw", "*"],
        (raw) => (raw === "*" || raw.startsWith("#") ? raw : `#${raw}`),
      ),
      {
        enabled: true,
        groupPolicy: "allowlist",
        groups: { "#openclaw": {}, "#ops": {}, "*": {} },
      },
    );

    expectIrcConfig(
      setIrcGroupAccess(cfg, "default", "disabled", [], () => null),
      {
        enabled: true,
        groupPolicy: "disabled",
      },
    );
  });

  it("validates required input and applies normalized account config", () => {
    const validate = (host: string, nick: string, port?: string) =>
      ircSetupAdapter.validateInput!({ input: { host, nick, port } } as never);
    const portError = "IRC port must be between 1 and 65535.";
    expect(validate("", "openclaw")).toBe("IRC requires host.");
    expect(validate("irc.libera.chat", "")).toBe("IRC requires nick.");
    expect(validate("irc.libera.chat", "openclaw")).toBeNull();
    expect(validate("irc.libera.chat", "openclaw", "+07000")).toBeNull();
    expect(validate("irc.libera.chat", "openclaw", "7000x")).toBe(portError);
    expect(validate("irc.libera.chat", "openclaw", "70000")).toBe(portError);

    expect(
      ircSetupAdapter.applyAccountConfig({
        cfg: ircConfig({}),
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
    ).toEqual(
      ircConfig({
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
      }),
    );
  });

  it("configures host and nick via setup prompts", async () => {
    const result = await runSetupWizardConfigure({
      configure: ircConfigureAdapter.configure,
      cfg: {},
      options: {},
      prompter: makePrompter(
        {
          "IRC server host": "irc.libera.chat",
          "IRC server port": "6697",
          "IRC nick": "openclaw-bot",
          "IRC username": "openclaw",
          "IRC real name": "OpenClaw Bot",
          "Auto-join IRC channels*": "#openclaw, #ops",
          "IRC channels allowlist*": "#openclaw, #ops",
        },
        ["Use TLS for IRC?", "Configure IRC channels access?"],
      ),
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.irc).toMatchObject({
      enabled: true,
      host: "irc.libera.chat",
      nick: "openclaw-bot",
      tls: true,
      channels: ["#openclaw", "#ops"],
      groupPolicy: "allowlist",
    });
    expect(Object.keys(result.cfg.channels?.irc?.groups ?? {})).toEqual(["#openclaw", "#ops"]);
  });

  it("rejects partial IRC setup wizard ports", async () => {
    const validate = ircSetupWizard.textInputs!.find(
      (step) => step.inputKey === "httpPort",
    )!.validate!;
    expect(validate({ value: "7000x" } as never)).toBe("Use a port between 1 and 65535");
    expect(validate({ value: "+07000" } as never)).toBeUndefined();
    expect(validate({ value: "7000" } as never)).toBeUndefined();
  });

  it("writes DM allowFrom to top-level config for non-default account prompts", async () => {
    const updated = await promptSetupWizardAllowFrom({
      promptAllowFrom: ircConfigureAdapter.dmPolicy!.promptAllowFrom!,
      cfg: ircConfig({ accounts: { work: { host: "irc.libera.chat", nick: "openclaw-work" } } }),
      prompter: makePrompter({
        "IRC allowFrom (nick or nick!user@host)": "Alice, Bob!ident@example.org",
      }),
      accountId: "work",
    });
    if (!updated) {
      throw new Error("expected IRC allowFrom setup to return updated config");
    }

    expect(updated.channels?.irc?.allowFrom).toEqual(["alice", "bob!ident@example.org"]);
    expect(updated.channels?.irc?.accounts?.work?.allowFrom).toBeUndefined();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = vi.fn();
    hoisted.monitorIrcProvider.mockResolvedValue({ stop });

    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: ircPlugin.gateway!.startAccount!,
      account: resolveIrcAccount({ cfg: ircConfig({ host: "irc.example.com", nick: "openclaw" }) }),
    });

    await expectStopPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.monitorIrcProvider),
      isSettled,
      abort,
      task,
      stop,
    });
  });
});
