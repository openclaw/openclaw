import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";
import { beforeEach, expect, it, vi } from "vitest";
import type { PluginRuntime } from "./api.js";
import register from "./index.js";

const gatewayMocks = vi.hoisted(() => ({ callGatewayTool: vi.fn() }));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => gatewayMocks);

type CommandContext = Parameters<OpenClawPluginCommandDefinition["handler"]>[0];
type ConfigMutation = {
  mutate: (draft: Record<string, unknown>) => void;
  writeOptions?: { assertCurrent?: () => void };
};

function createHarness(
  initialConfig: Record<string, unknown>,
  voices?: SpeechVoiceOption[] | Error,
) {
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
    run: (args: string, context?: Partial<CommandContext>) =>
      command.handler(createCommandContext(args, context)),
  };
}

function talkConfig(provider: string, config: Record<string, unknown> = {}) {
  return { talk: { provider, providers: { [provider]: config } } };
}

const claudia = [{ id: "voice-a", name: "Claudia" }];
const elevenlabs = talkConfig("elevenlabs", { apiKey: "sk-eleven" });

function createCommandContext(
  args: string,
  overrides: Partial<CommandContext> = {},
): CommandContext {
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

beforeEach(() => {
  gatewayMocks.callGatewayTool.mockReset();
});

it.each(["owner", "revoked owner", "gateway admin"])(
  "checks write authority after voice lookup: %s",
  async (authority) => {
    const gatewayAdmin = authority === "gateway admin";
    const initialConfig = talkConfig("microsoft");
    const { command, runtime, listVoices } = createHarness(initialConfig);
    expect(command.exposeSenderIsOwner).toBe(true);
    let current = true;
    const ctx = {
      ...createCommandContext("set Ava", {
        channel: authority === "owner" ? "telegram" : "discord",
        gatewayClientScopes: gatewayAdmin ? ["operator.admin"] : undefined,
        senderIsOwner: gatewayAdmin ? undefined : true,
      }),
      assertOwnerCurrent: () => {
        if (!current) {
          throw new Error("original owner revoked");
        }
      },
    };
    listVoices.mockImplementationOnce(async () => {
      current = authority === "owner";
      ctx.assertOwnerCurrent = () => {};
      return [{ id: "en-US-AvaNeural", name: "Ava" }];
    });
    const pending = command.handler(ctx);
    if (authority !== "revoked owner") {
      await expect(pending).resolves.toEqual({
        text: "✅ Microsoft Talk voice set to Ava\nen-US-AvaNeural",
      });
      expect(runtime.config.mutateConfigFile).toHaveBeenCalled();
      expect(runtime.config.current()).toStrictEqual(
        talkConfig("microsoft", { voiceId: "en-US-AvaNeural" }),
      );
    } else {
      await expect(pending).rejects.toThrow("original owner revoked");
      expect(runtime.config.current()).toEqual(initialConfig);
    }
  },
);

it.each([
  { action: "list", method: "talk.voice.get", request: {} },
  { action: "set", method: "talk.voice.set", request: { voice: "marin" } },
])(
  "executes $action for the host session despite model targets and waits for the Gateway result",
  async ({ action, method, request }) => {
    const { tool, runtime } = createHarness({});
    const rpc = createDeferred<Record<string, unknown>>();
    const started = createDeferred<void>();
    gatewayMocks.callGatewayTool.mockImplementation(() => {
      started.resolve();
      return rpc.promise;
    });
    const controller = new AbortController();
    const completed = vi.fn();
    const pending = tool
      .execute(
        "voice-tool-call",
        {
          action,
          voice: "marin",
          sessionKey: "agent:other:main",
          voiceSessionId: "other-call",
          gatewayUrl: "wss://other.example.test",
          gatewayToken: "test-override-token",
        },
        controller.signal,
      )
      .finally(completed);

    await started.promise;
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledOnce();
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      method,
      { timeoutMs: 65_000 },
      { ...request, sessionKey: "agent:main:main" },
      { requireAgentRuntimeIdentity: true, signal: controller.signal },
    );
    expect(completed).not.toHaveBeenCalled();
    const response = {
      voiceSessionId: "current-call",
      voice: "marin",
      ...(action === "set" ? { status: "applied" } : {}),
    };
    rpc.resolve(response);

    expect((await pending).details).toEqual(response);
    expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
    expect(runtime.tts.listVoices).not.toHaveBeenCalled();
  },
);

it("reports active provider status", async () => {
  const { run } = createHarness(
    talkConfig("microsoft", { voiceId: "en-US-AvaNeural", apiKey: "secret-token" }),
  );
  expect(await run("")).toEqual({
    text: `Talk voice status:
- provider: microsoft
- talk.providers.microsoft.voiceId: en-US-AvaNeural
- microsoft.apiKey: secret…`,
  });
});

it.each([
  {
    name: "does not coerce partial voice list limits",
    args: "list 1x",
    voices: Array.from({ length: 13 }, () => ({ id: "voice", name: "Voice" })),
    text: expect.stringContaining("(showing first 12)"),
  },
  {
    name: "surfaces richer provider voice metadata when available",
    args: "list",
    voices: [
      {
        id: "en-US-AvaNeural",
        name: "Ava",
        category: "General",
        locale: "en-US",
        gender: "Female",
        personalities: ["Friendly", "Positive"],
        description: "Friendly, Positive",
      },
    ],
    text: `Microsoft voices: 1

- Ava · General
  id: en-US-AvaNeural
  meta: en-US · Female · Friendly, Positive
  note: Friendly, Positive`,
  },
  {
    name: "returns provider lookup errors cleanly",
    args: "list",
    voices: new Error("speech provider microsoft does not support voice listing"),
    text: "Microsoft voice list failed: speech provider microsoft does not support voice listing",
  },
])("$name", async ({ args, voices, text }) => {
  const { run } = createHarness(talkConfig("microsoft"), voices);
  expect(await run(args)).toEqual({ text });
});

it.each([
  { channel: "telegram", scopes: ["operator.write"] },
  { channel: "discord", scopes: undefined },
])("rejects unauthorized voice writes on $channel", async ({ channel, scopes }) => {
  const { mutate, run } = createHarness(elevenlabs, claudia);
  const result = await run("set Claudia", { channel, gatewayClientScopes: scopes });
  expect(result.text).toContain("requires operator.admin");
  expect(mutate).not.toHaveBeenCalled();
});

it("keeps read-only voice commands available without operator.admin", async () => {
  const { mutate, run } = createHarness(elevenlabs, claudia);
  const status = await run("status", { channel: "telegram" });
  const list = await run("list", { channel: "telegram" });
  expect(status.text).toContain("Talk voice status:");
  expect(list.text).toContain("ElevenLabs voices: 1");
  expect(mutate).not.toHaveBeenCalled();
});
