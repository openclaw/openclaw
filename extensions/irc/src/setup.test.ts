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
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  listIrcAccountIds,
  resolveDefaultIrcAccountId,
  type ResolvedIrcAccount,
} from "./accounts.js";
import { ircPlugin } from "./channel.js";
import {
  ircSetupAdapter,
  setIrcAllowFrom,
  setIrcDmPolicy,
  setIrcGroupAccess,
  setIrcNickServ,
  updateIrcAccountConfig,
} from "./setup-core.js";
import { ircSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

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

const account: ResolvedIrcAccount = {
  accountId: "default",
  enabled: true,
  configured: true,
  host: "irc.example.com",
  port: 6697,
  tls: true,
  nick: "openclaw",
  username: "openclaw",
  realname: "OpenClaw",
  password: "",
  passwordSource: "none",
  config: {},
};

describe("irc setup", () => {
  afterEach(() => vi.clearAllMocks());

  it("updates top-level dm policy and allowlist", () => {
    const cfg: CoreConfig = ircConfig({});

    expectIrcConfig(setIrcDmPolicy(cfg, "open"), { dmPolicy: "open", allowFrom: ["*"] });
    expectIrcConfig(setIrcAllowFrom(cfg, ["alice", "bob"]), { allowFrom: ["alice", "bob"] });
  });

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
    const validateInput = ircSetupAdapter.validateInput;
    const applyAccountConfig = ircSetupAdapter.applyAccountConfig;
    expect(validateInput).toBeTypeOf("function");
    expect(applyAccountConfig).toBeTypeOf("function");
    if (!validateInput) {
      throw new Error("Expected IRC setup validateInput");
    }

    const validate = (host: string, nick: string, port?: string) =>
      validateInput({ input: { host, nick, port } } as never);
    const portError = "IRC port must be between 1 and 65535.";
    expect(validate("", "openclaw")).toBe("IRC requires host.");
    expect(validate("irc.libera.chat", "")).toBe("IRC requires nick.");
    expect(validate("irc.libera.chat", "openclaw")).toBeNull();
    expect(validate("irc.libera.chat", "openclaw", "+07000")).toBeNull();
    expect(validate("irc.libera.chat", "openclaw", "7000x")).toBe(portError);
    expect(validate("irc.libera.chat", "openclaw", "70000")).toBe(portError);

    expect(
      applyAccountConfig({
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
    const prompter = makePrompter(
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
    );

    const result = await runSetupWizardConfigure({
      configure: ircConfigureAdapter.configure,
      cfg: {} as CoreConfig,
      prompter,
      options: {},
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
    const portPrompt = ircSetupWizard.textInputs?.find((step) => step.inputKey === "httpPort");
    if (!portPrompt?.validate) {
      throw new Error("expected IRC port prompt validator");
    }

    expect(portPrompt.validate({ value: "7000x" } as never)).toBe("Use a port between 1 and 65535");
    expect(portPrompt.validate({ value: "+07000" } as never)).toBeUndefined();
    expect(portPrompt.validate({ value: "7000" } as never)).toBeUndefined();
  });

  it("writes DM allowFrom to top-level config for non-default account prompts", async () => {
    const prompter = makePrompter({
      "IRC allowFrom (nick or nick!user@host)": "Alice, Bob!ident@example.org",
    });

    const promptAllowFrom = ircConfigureAdapter.dmPolicy?.promptAllowFrom;
    if (!promptAllowFrom) {
      throw new Error("promptAllowFrom unavailable");
    }

    const cfg = ircConfig({
      accounts: { work: { host: "irc.libera.chat", nick: "openclaw-work" } },
    });

    const updated = await promptSetupWizardAllowFrom({
      promptAllowFrom,
      cfg,
      prompter,
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
      account,
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
