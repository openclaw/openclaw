import type { ChatCommandDefinition } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { clearPluginCommands } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { createArgMenusHarness } from "./slash.arg-menu.test-support.js";
import { getSlackSlashMocks, resetSlackSlashMocks } from "./slash.test-harness.js";

const fixtures = vi.hoisted(() => {
  const definitions: ChatCommandDefinition[] = [
    {
      key: "model",
      nativeName: "model",
      description: "Sensitive model catalog",
      textAliases: [],
      acceptsArgs: true,
      argsParsing: "positional",
      argsMenu: "auto",
      args: [
        {
          name: "model",
          description: "model",
          type: "string",
          choices: ["internal/model-a", "internal/model-b"],
        },
      ],
      scope: "native",
    },
    {
      key: "reportexternal",
      nativeName: "reportexternal",
      description: "Large private catalog",
      textAliases: [],
      acceptsArgs: true,
      argsParsing: "positional",
      argsMenu: "auto",
      args: [
        {
          name: "period",
          description: "period",
          type: "string",
          choices: Array.from({ length: 140 }, (_value, index) => `period-${index + 1}`),
        },
      ],
      scope: "native",
    },
  ];
  return {
    definitions,
    resolveCommandArgMenu: vi.fn(),
  };
});

vi.mock("./slash-commands.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./slash-commands.runtime.js")>(
    "./slash-commands.runtime.js",
  );
  fixtures.resolveCommandArgMenu.mockImplementation(actual.resolveCommandArgMenu);
  return {
    ...actual,
    resolveCommandArgMenu: fixtures.resolveCommandArgMenu,
    findCommandByNativeName: (name: string) =>
      fixtures.definitions.find((definition) => definition.nativeName === name),
    listNativeCommandSpecsForConfig: () =>
      fixtures.definitions.map((definition): NativeCommandSpec => ({
        name: definition.nativeName!,
        description: definition.description,
        acceptsArgs: true,
        args: definition.args,
      })),
  };
});

setActivePluginRegistry(createEmptyPluginRegistry());
const { registerSlackMonitorSlashCommands } = await import("./slash.js");
const { dispatchMock } = getSlackSlashMocks();

beforeEach(() => {
  resetSlackSlashMocks();
  fixtures.resolveCommandArgMenu.mockClear();
  clearPluginCommands();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

function requireHandler(
  handlers: Map<string | RegExp, (args: unknown) => Promise<void>>,
  key: string,
) {
  const handler = handlers.get(key);
  if (!handler) {
    throw new Error(`Missing ${key} handler`);
  }
  return handler;
}

const createConfig = (allowFrom: string[]): OpenClawConfig => ({
  commands: { native: true, nativeSkills: false, allowFrom: { slack: allowFrom } },
});

async function registerHarness(cfg: OpenClawConfig) {
  const harness = createArgMenusHarness(cfg);
  await registerSlackMonitorSlashCommands({
    ctx: harness.ctx as never,
    account: harness.account as never,
  });
  return harness;
}

async function invokeCommand(handler: (args: unknown) => Promise<void>, userId = "U1") {
  const respond = vi.fn().mockResolvedValue(undefined);
  await handler({
    command: {
      user_id: userId,
      user_name: userId === "U_OWNER" ? "Owner" : "Mallory",
      channel_id: "D1",
      channel_name: "directmessage",
      text: "",
      trigger_id: "t1",
    },
    ack: vi.fn().mockResolvedValue(undefined),
    respond,
  });
  return respond;
}

function readExternalBlockId(respond: ReturnType<typeof vi.fn>): string {
  const payload = respond.mock.calls[0]?.[0] as {
    blocks?: Array<{ type?: string; block_id?: string }>;
  };
  const blockId = payload?.blocks?.find((block) => block.type === "actions")?.block_id;
  if (!blockId) {
    throw new Error("Missing external menu block ID");
  }
  return blockId;
}

it("does not resolve any native arg menu before core command authorization", async () => {
  const harness = await registerHarness(createConfig(["U_OWNER"]));
  const modelHandler = requireHandler(harness.commands, "/model");
  const externalHandler = requireHandler(harness.commands, "/reportexternal");

  const modelResponse = await invokeCommand(modelHandler, "U_ATTACKER");
  const externalResponse = await invokeCommand(externalHandler, "U_ATTACKER");

  expect(fixtures.resolveCommandArgMenu).not.toHaveBeenCalled();
  expect(modelResponse).not.toHaveBeenCalledWith(
    expect.objectContaining({ blocks: expect.any(Array) }),
  );
  expect(externalResponse).not.toHaveBeenCalledWith(
    expect.objectContaining({ blocks: expect.any(Array) }),
  );
  expect(dispatchMock).toHaveBeenCalledTimes(2);

  const ownerResponse = await invokeCommand(modelHandler, "U_OWNER");
  expect(fixtures.resolveCommandArgMenu).toHaveBeenCalledTimes(1);
  expect(ownerResponse).toHaveBeenCalledWith(
    expect.objectContaining({ blocks: expect.any(Array) }),
  );
});

it("rechecks core and Slack policy before serving stored external choices", async () => {
  const cfg = createConfig(["*"]);
  const harness = await registerHarness(cfg);
  const commandHandler = requireHandler(harness.commands, "/reportexternal");
  const optionsHandler = requireHandler(harness.options, "openclaw_cmdarg");
  const respond = await invokeCommand(commandHandler);
  const blockId = readExternalBlockId(respond);
  const query = async (body: Record<string, unknown>) => {
    const ack = vi.fn().mockResolvedValue(undefined);
    await optionsHandler({ ack, body });
    return ack;
  };

  cfg.commands!.allowFrom = { slack: ["U_OWNER"] };
  const coreDenied = await query({
    user: { id: "U1" },
    value: "period-12",
    actions: [{ block_id: blockId }],
  });
  expect(coreDenied).toHaveBeenCalledOnce();
  expect(coreDenied).toHaveBeenCalledWith({ options: [] });

  delete cfg.commands!.allowFrom;
  (harness.ctx as { allowFrom: string[] }).allowFrom = ["U_OWNER"];
  const slackDenied = await query({
    user: { id: "U1" },
    value: "period-12",
    actions: [{ block_id: blockId }],
  });
  expect(slackDenied).toHaveBeenCalledOnce();
  expect(slackDenied).toHaveBeenCalledWith({ options: [] });

  (harness.ctx as { allowFrom: string[] }).allowFrom = ["*"];
  const allowed = await query({
    user: { id: "U1" },
    value: "period-12",
    actions: [{ block_id: blockId }],
  });
  expect(allowed).toHaveBeenCalledOnce();
  expect(allowed.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ options: expect.any(Array) }),
  );

  const wrongChannel = await query({
    user: { id: "U1" },
    channel: { id: "D_OTHER" },
    value: "period-12",
    actions: [{ block_id: blockId }],
  });
  expect(wrongChannel).toHaveBeenCalledOnce();
  expect(wrongChannel).toHaveBeenCalledWith({ options: [] });
  expect(harness.postEphemeral).not.toHaveBeenCalled();
});
