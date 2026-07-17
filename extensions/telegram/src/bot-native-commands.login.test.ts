// Tests Telegram native Codex login command behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramGroupCommandContext } from "./bot-native-commands.fixture-test-support.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
  listSkillCommandsForAgents,
  resetNativeCommandMenuMocks,
  waitForRegisteredCommands,
} from "./bot-native-commands.menu-test-support.js";
import { resetTelegramForumFlagCacheForTest } from "./bot/helpers.js";
import { resetPluginCommandMocks } from "./test-support/plugin-command.js";

let registerTelegramNativeCommands: typeof import("./bot-native-commands.js").registerTelegramNativeCommands;

type LoginFlowMock = ReturnType<typeof vi.fn>;

function registerLoginCommand(params: {
  cfg: OpenClawConfig;
  loginFlow: LoginFlowMock;
  allowFrom?: string[];
}) {
  const botHarness = createCommandBot();
  const nativeParams = createNativeCommandTestParams(params.cfg, {
    bot: botHarness.bot,
    allowFrom: params.allowFrom ?? ["200"],
  });
  registerTelegramNativeCommands({
    ...nativeParams,
    telegramDeps: {
      ...nativeParams.telegramDeps,
      runModelsAuthLoginFlow: params.loginFlow,
    } as never,
  });
  const handler = botHarness.commandHandlers.get("login");
  if (!handler) {
    throw new Error("expected login command handler to be registered");
  }
  return {
    ...botHarness,
    handler,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function installCommandDenialPolicy() {
  const handler = vi.fn(() => ({ effect: "deny" as const, code: "native-command-denied" }));
  const registry = createEmptyPluginRegistry();
  registry.authorizationPolicies.push({
    pluginId: "sender-access",
    source: "test",
    policy: {
      id: "maintainer-actions",
      description: "Deny native command shortcuts",
      handlers: { "command.invoke": handler },
    },
  });
  setActivePluginRegistry(registry);
  return handler;
}

describe("registerTelegramNativeCommands /login", () => {
  beforeAll(async () => {
    ({ registerTelegramNativeCommands } = await import("./bot-native-commands.js"));
  });

  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetTelegramForumFlagCacheForTest();
    resetNativeCommandMenuMocks();
    resetPluginCommandMocks();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("blocks /login before reserving or starting the login flow", async () => {
    const authorizationHandler = installCommandDenialPolicy();
    const loginFlow = vi.fn(async () => {
      throw new Error("login flow should not start");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          ownerAllowFrom: ["200"],
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(authorizationHandler).toHaveBeenCalledTimes(1);
    expect(loginFlow).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toEqual([
      "Command blocked by authorization policy.",
    ]);
  });

  it("leaves skill command authorization to the skill dispatch path", async () => {
    const botHarness = createCommandBot();
    listSkillCommandsForAgents.mockReturnValue([
      {
        name: "demo_skill",
        skillName: "demo-skill",
        description: "Demo skill",
      },
    ]);
    const cfg: OpenClawConfig = {
      commands: { native: true, nativeSkills: true },
      agents: { list: [{ id: "main", default: true }] },
    };
    const nativeParams = createNativeCommandTestParams(cfg, {
      bot: botHarness.bot,
      allowFrom: ["200"],
    });
    const dispatch = nativeParams.telegramDeps?.dispatchReplyWithBufferedBlockDispatcher;
    const corePolicy = vi.fn((request: unknown) =>
      (request as { owner?: { kind?: string } }).owner?.kind === "core"
        ? ({ effect: "deny", code: "core-only" } as const)
        : ({ effect: "pass" } as const),
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "test",
      policy: {
        id: "maintainer-actions",
        description: "Deny core commands only",
        handlers: { "command.invoke": corePolicy },
      },
    });
    setActivePluginRegistry(registry);
    registerTelegramNativeCommands(nativeParams);
    const handler = botHarness.commandHandlers.get("demo_skill");
    expect(handler).toBeDefined();

    await handler?.(createPrivateCommandContext({ userId: 200 }));

    expect(corePolicy).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("handles /login codex by sending the device code before login completes", async () => {
    const loginFlow = vi.fn(
      async (params: {
        provider?: string;
        method?: string;
        agent?: string;
        prompter: { note: (message: string, title?: string) => Promise<void> };
      }) => {
        expect(params.provider).toBe("openai");
        expect(params.method).toBe("device-code");
        expect(params.agent).toBe("main");
        await params.prompter.note(
          [
            "Open this URL in your LOCAL browser and enter the code below.",
            "URL: https://auth.openai.com/codex/device",
            "Code: ABCD-EFGH",
            "Code expires in 15 minutes. Never share it.",
          ].join("\n"),
          "OpenAI Codex device code",
        );
        return {
          providerId: "openai",
          methodId: "device-code",
          profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
        };
      },
    );
    const { handler, sendMessage, setMyCommands } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          ownerAllowFrom: ["200"],
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands).toContainEqual({
      command: "login",
      description: "Pair Codex login.",
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    const texts = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(texts[0]).toContain("URL: https://auth.openai.com/codex/device");
    expect(texts[0]).toContain("Code: ABCD-EFGH");
    expect(texts[0]).toContain("Never share it.");
    expect(texts.at(-1)).toContain("Codex login complete. Try your request again now.");
  });

  it("rejects group /login codex without sending the device code publicly", async () => {
    const loginFlow = vi.fn(
      async (params: {
        prompter: { note: (message: string, title?: string) => Promise<void> };
      }) => {
        await params.prompter.note("URL: https://auth.openai.com/codex/device\nCode: SECRET");
        return {
          providerId: "openai",
          methodId: "device-code",
          profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
        };
      },
    );
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          ownerAllowFrom: ["200"],
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
      allowFrom: ["200"],
    });

    await handler(createTelegramGroupCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    const texts = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(texts).toContain(
      "For safety, Codex login codes are only sent in a private chat with this bot. DM this bot `/login codex` to pair Codex.",
    );
    expect(texts.join("\n")).not.toContain("SECRET");
    expect(texts.join("\n")).not.toContain("https://auth.openai.com/codex/device");
  });

  it("rejects /login for authorized senders who are not owners", async () => {
    const loginFlow = vi.fn(async () => ({
      providerId: "openai",
      methodId: "device-code",
      profiles: [],
    }));
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          allowFrom: { telegram: ["200"] },
          ownerAllowFrom: ["999"],
        },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "Only a configured OpenClaw owner can start Codex login from Telegram.",
    );
  });

  it("dedupes active /login flows for the same Telegram thread", async () => {
    const deferred = createDeferred<void>();
    const loginFlow = vi.fn(
      async (params: {
        prompter: { note: (message: string, title?: string) => Promise<void> };
      }) => {
        await params.prompter.note(
          [
            "Open this URL in your LOCAL browser and enter the code below.",
            "URL: https://auth.openai.com/codex/device",
            "Code: FIRST-CODE",
            "Code expires in 15 minutes. Never share it.",
          ].join("\n"),
          "OpenAI Codex device code",
        );
        await deferred.promise;
        return {
          providerId: "openai",
          methodId: "device-code",
          profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
        };
      },
    );
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          ownerAllowFrom: ["200"],
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });

    const first = handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await vi.waitFor(() => expect(loginFlow).toHaveBeenCalledTimes(1));
    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    deferred.resolve();
    await first;

    expect(loginFlow).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "A Codex login code is already active for this Telegram chat. Complete it, or wait for it to expire before requesting a new one.",
    );
  });
});
