import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";
import { expect, it, vi } from "vitest";
import type { PluginRuntime } from "./api.js";
import register from "./index.js";

const gatewayMocks = vi.hoisted(() => ({ callGatewayTool: vi.fn() }));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => gatewayMocks);

type CommandContext = Parameters<OpenClawPluginCommandDefinition["handler"]>[0];
type CommandOverrides = Partial<CommandContext>;
type Config = Record<string, unknown>;
type ConfigMutation = {
  mutate: (draft: Config) => void;
  writeOptions?: { assertCurrent?: () => void };
};

function createHarness(initialConfig: Config, voices?: SpeechVoiceOption[] | Error) {
  let config = initialConfig;
  const listVoices = vi.fn<PluginRuntime["tts"]["listVoices"]>();
  if (voices instanceof Error) {
    listVoices.mockRejectedValue(voices);
  } else if (voices) {
    listVoices.mockResolvedValue(voices);
  }
  const runtime = {
    config: {
      current: vi.fn(() => config),
      mutateConfigFile: vi.fn(async ({ mutate, writeOptions }: ConfigMutation) => {
        const draft = structuredClone(config);
        mutate(draft);
        writeOptions?.assertCurrent?.();
        config = draft;
      }),
    },
    tts: { listVoices },
  };
  const registerCommand = vi.fn<(definition: OpenClawPluginCommandDefinition) => void>();
  const registerTool = vi.fn<(definition: AnyAgentTool | OpenClawPluginToolFactory) => void>();
  register.register({ runtime, registerCommand, registerTool } as never);
  const command = registerCommand.mock.calls[0]?.[0];
  const definition = registerTool.mock.calls[0]?.[0];
  const tool =
    typeof definition === "function" ? definition({ sessionKey: "agent:main:main" }) : definition;
  if (!command || !tool || Array.isArray(tool)) {
    throw new Error("talk-voice command or tool not registered");
  }
  return {
    command,
    tool,
    runtime,
    listVoices,
    mutate: runtime.config.mutateConfigFile,
    run: (args: string, context?: CommandOverrides) =>
      command.handler(createCommandContext(args, context)),
  };
}

function talkConfig(provider: string, config: Config = {}) {
  return { talk: { provider, providers: { [provider]: config } } };
}

const voice = (id: string, name: string): SpeechVoiceOption => ({ id, name });

function createCommandContext(args: string, overrides: CommandOverrides = {}): CommandContext {
  return {
    args,
    channel: "discord",
    channelId: overrides.channel ?? "discord",
    isAuthorizedSender: true,
    commandBody: args ? `/voice ${args}` : "/voice",
    config: {},
    requestConversationBinding: vi.fn(),
    detachConversationBinding: vi.fn(),
    getCurrentConversationBinding: vi.fn(),
    ...overrides,
  };
}

it.each(["revoked owner", "gateway admin"])(
  "rechecks %s authority after lookup",
  async (authority) => {
    const gatewayAdmin = authority === "gateway admin";
    const initialConfig = talkConfig("microsoft");
    const { command, runtime, listVoices } = createHarness(initialConfig);
    expect(command.exposeSenderIsOwner).toBe(true);
    const assertOwnerCurrent = vi.fn();
    const ctx = createCommandContext("set Ava", {
      gatewayClientScopes: gatewayAdmin ? ["operator.admin"] : undefined,
      senderIsOwner: gatewayAdmin ? undefined : true,
      assertOwnerCurrent,
    });
    listVoices.mockImplementationOnce(async () => {
      assertOwnerCurrent.mockImplementation(() => {
        throw new Error("original owner revoked");
      });
      ctx.assertOwnerCurrent = () => {};
      return [{ id: "en-US-AvaNeural", name: "Ava" }];
    });
    const pending = command.handler(ctx);
    if (gatewayAdmin) {
      await pending;
    } else {
      await expect(pending).rejects.toThrow("original owner revoked");
    }
    expect(runtime.config.current()).toStrictEqual(
      gatewayAdmin ? talkConfig("microsoft", { voiceId: "en-US-AvaNeural" }) : initialConfig,
    );
  },
);

it.each([
  ["list", "talk.voice.get", {}],
  ["set", "talk.voice.set", { voice: "marin" }],
] satisfies [string, string, Record<string, string>][])(
  "routes %s through the host session and awaits RPC",
  async (action, method, request) => {
    const { tool, runtime } = createHarness({});
    const rpc = createDeferred<Record<string, unknown>>();
    const started = createDeferred<void>();
    gatewayMocks.callGatewayTool.mockReset().mockImplementation(() => {
      started.resolve();
      return rpc.promise;
    });
    const controller = new AbortController();
    const completed = vi.fn();
    const params = {
      action,
      voice: "marin",
      sessionKey: "agent:other:main",
      voiceSessionId: "other-call",
      gatewayUrl: "wss://other.example.test",
      gatewayToken: "test-override-token",
    };
    const pending = tool.execute("voice-tool-call", params, controller.signal).finally(completed);

    await started.promise;
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      method,
      { timeoutMs: 65_000 },
      { ...request, sessionKey: "agent:main:main" },
      { requireAgentRuntimeIdentity: true, signal: controller.signal },
    );
    expect(completed).not.toHaveBeenCalled();
    const response = { voice: "marin", status: action === "set" ? "applied" : "available" };
    rpc.resolve(response);

    expect((await pending).details).toEqual(response);
    expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  },
);

it("reports active provider status", async () => {
  const { run, mutate } = createHarness(
    talkConfig("microsoft", { voiceId: "en-US-AvaNeural", apiKey: "secret-token" }),
  );
  expect(await run("", { channel: "telegram" })).toEqual({
    text: "Talk voice status:\n- provider: microsoft\n- talk.providers.microsoft.voiceId: en-US-AvaNeural\n- microsoft.apiKey: secret…",
  });
  expect(mutate).not.toHaveBeenCalled();
});

it("lists metadata without admin authority and rejects partial limits", async () => {
  const { run, mutate } = createHarness(talkConfig("microsoft"), [
    {
      ...voice("en-US-AvaNeural", "Ava"),
      category: "General",
      locale: "en-US",
      gender: "Female",
      personalities: ["Friendly", "Positive"],
      description: "Friendly, Positive",
    },
    ...Array.from({ length: 12 }, () => voice("voice", "Voice")),
  ]);
  const { text } = await run("list 1x", { channel: "telegram" });
  expect(text).toBe(
    "Microsoft voices: 13\n\n- Ava · General\n  id: en-US-AvaNeural\n  meta: en-US · Female · Friendly, Positive\n  note: Friendly, Positive\n" +
      "- Voice\n  id: voice\n".repeat(11) +
      "\n(showing first 12)",
  );
  expect(mutate).not.toHaveBeenCalled();
});

it("returns provider lookup errors cleanly", async () => {
  const message = "speech provider elevenlabs does not support voice listing";
  const { run } = createHarness(talkConfig("elevenlabs"), new Error(message));
  expect(await run("list")).toEqual({ text: `ElevenLabs voice list failed: ${message}` });
});

it.each([
  ["telegram", ["operator.write"], undefined],
  ["discord", undefined, undefined],
  ["discord", ["operator.write"], true],
] satisfies [string, string[] | undefined, boolean | undefined][])(
  "rejects %s writes (scopes=%j, owner=%s)",
  async (channel, gatewayClientScopes, senderIsOwner) => {
    const { mutate, run, listVoices } = createHarness(talkConfig("elevenlabs"));
    const result = await run("set Claudia", { channel, gatewayClientScopes, senderIsOwner });
    expect(result.text).toContain("requires operator.admin");
    expect(listVoices).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  },
);

it.each([
  ["voice-b", "voice-b", "Claudia", "voice-b", "Claudia"],
  ["CLAUDIA", "Claudia bright", "Claudia", "voice-b", "Claudia"],
  ["bright", "Claudia bright", "Bright second", "voice-a", "Claudia bright"],
])(
  "selects %s by ID, exact name, then partial name",
  async (query, first, second, voiceId, name) => {
    const { run, runtime } = createHarness(talkConfig("microsoft"), [
      voice("voice-a", first),
      voice("voice-b", second),
    ]);
    expect(await run(`set ${query}`, { senderIsOwner: true })).toEqual({
      text: `✅ Microsoft Talk voice set to ${name}\n${voiceId}`,
    });
    expect(runtime.config.current()).toStrictEqual(talkConfig("microsoft", { voiceId }));
  },
);
