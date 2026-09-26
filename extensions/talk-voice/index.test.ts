import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "./api.js";
import register from "./index.js";

const gatewayMocks = vi.hoisted(() => ({ callGatewayTool: vi.fn() }));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => gatewayMocks);

function createHarness(initialConfig: Record<string, unknown>) {
  let config = initialConfig;
  let command: OpenClawPluginCommandDefinition | undefined;
  let tool: AnyAgentTool | undefined;
  const runtime = {
    config: {
      current: vi.fn(() => config),
      mutateConfigFile: vi.fn(
        async ({
          mutate,
          writeOptions,
        }: {
          mutate: (draft: Record<string, unknown>) => void;
          writeOptions?: { assertCurrent?: () => void };
        }) => {
          const draft = structuredClone(config);
          mutate(draft);
          writeOptions?.assertCurrent?.();
          config = draft;
          return {
            path: "/tmp/openclaw.json",
            previousHash: null,
            persistedHash: null,
            snapshot: {},
            nextConfig: config,
            afterWrite: { mode: "auto" },
            followUp: { mode: "auto", requiresRestart: false },
            result: undefined,
          };
        },
      ),
    },
    tts: {
      listVoices: vi.fn(),
    },
  } as unknown as PluginRuntime;
  const api = {
    runtime,
    registerCommand: vi.fn((definition: OpenClawPluginCommandDefinition) => {
      command = definition;
    }),
    registerTool: vi.fn((definition: AnyAgentTool) => {
      tool = definition;
    }),
  };
  register.register(api as never);
  if (!command || !tool) {
    throw new Error("talk-voice command or tool not registered");
  }
  return { command, tool, runtime };
}

function talkConfig(provider: string, config: Record<string, unknown> = {}) {
  return { talk: { provider, providers: { [provider]: config } } };
}

function createCommandContext(
  args: string,
  channel = "discord",
  gatewayClientScopes?: string[],
  senderIsOwner?: boolean,
) {
  return {
    args,
    channel,
    channelId: channel,
    isAuthorizedSender: true,
    gatewayClientScopes,
    senderIsOwner,
    commandBody: args ? `/voice ${args}` : "/voice",
    config: {},
    requestConversationBinding: vi.fn(),
    detachConversationBinding: vi.fn(),
    getCurrentConversationBinding: vi.fn(),
  };
}

describe("talk-voice plugin", () => {
  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
  });

  it.each([false, true])(
    "rechecks owner authority after voice lookup (gateway admin: %s)",
    async (gatewayAdmin) => {
      const initialConfig = talkConfig("microsoft");
      const { command, runtime } = createHarness(initialConfig);
      let current = true;
      const ctx = {
        ...createCommandContext(
          "set Ava",
          "discord",
          gatewayAdmin ? ["operator.admin"] : undefined,
          gatewayAdmin ? undefined : true,
        ),
        assertOwnerCurrent: () => {
          if (!current) {
            throw new Error("original owner revoked");
          }
        },
      };
      vi.mocked(runtime.tts.listVoices).mockImplementationOnce(async () => {
        current = false;
        ctx.assertOwnerCurrent = () => {};
        return [{ id: "en-US-AvaNeural", name: "Ava" }];
      });
      const pending = command.handler(ctx);
      if (gatewayAdmin) {
        await expect(pending).resolves.toMatchObject({
          text: expect.stringContaining("Talk voice set to Ava"),
        });
        expect(runtime.config.current()).toStrictEqual({
          talk: {
            provider: "microsoft",
            providers: { microsoft: { voiceId: "en-US-AvaNeural" } },
          },
        });
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
    "executes $action with trusted identity and waits for the Gateway result",
    async ({ action, method, request }) => {
      const { tool, runtime } = createHarness({});
      const rpc = createDeferred<Record<string, unknown>>();
      gatewayMocks.callGatewayTool.mockReturnValue(rpc.promise);
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
        .then((result) => {
          completed();
          return result;
        });

      await vi.waitFor(() => expect(gatewayMocks.callGatewayTool).toHaveBeenCalledOnce());
      expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
        method,
        { timeoutMs: 65_000 },
        request,
        { requireAgentRuntimeIdentity: true, signal: controller.signal },
      );
      expect(completed).not.toHaveBeenCalled();
      const response = {
        voiceSessionId: "current-call",
        sessionKey: "agent:main:main",
        provider: "openai",
        model: "gpt-live-1",
        voice: "marin",
        voices: ["marin", "cedar"],
        canChange: true,
        ...(action === "set" ? { status: "applied" } : {}),
      };
      rpc.resolve(response);

      expect((await pending).details).toEqual(response);
      expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
      expect(runtime.tts.listVoices).not.toHaveBeenCalled();
    },
  );

  it("returns a failed voice replacement as a tool failure", async () => {
    const { tool, runtime } = createHarness({});
    gatewayMocks.callGatewayTool.mockRejectedValue(new Error("Replacement voice call failed"));

    await expect(
      tool.execute("voice-tool-call", { action: "set", voice: "marin" }),
    ).rejects.toThrow("Replacement voice call failed");
    expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  function createElevenlabsVoiceSetHarness(channel: string, scopes?: string[]) {
    const { command, runtime } = createHarness(talkConfig("elevenlabs", { apiKey: "sk-eleven" }));
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "voice-a", name: "Claudia" }]);
    return {
      runtime,
      run: async () => await command.handler(createCommandContext("set Claudia", channel, scopes)),
    };
  }

  it("reports active provider status", async () => {
    const { command } = createHarness(
      talkConfig("microsoft", { voiceId: "en-US-AvaNeural", apiKey: "secret-token" }),
    );

    const result = await command.handler(createCommandContext(""));

    expect(result).toEqual({
      text:
        "Talk voice status:\n" +
        "- provider: microsoft\n" +
        "- talk.providers.microsoft.voiceId: en-US-AvaNeural\n" +
        "- microsoft.apiKey: secret…",
    });
  });

  it("lists voices from the active provider", async () => {
    const config = talkConfig("elevenlabs", {
      apiKey: "sk-eleven",
      baseUrl: "https://voices.example.test",
    });
    const { command, runtime } = createHarness(config);
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([
      { id: "voice-a", name: "Claudia", category: "general" },
      { id: "voice-b", name: "Bert" },
    ]);

    const result = await command.handler(createCommandContext("list +01"));

    expect(runtime.tts.listVoices).toHaveBeenCalledWith({
      provider: "elevenlabs",
      cfg: config,
      apiKey: "sk-eleven",
      baseUrl: "https://voices.example.test",
    });
    expect(result).toEqual({
      text:
        "ElevenLabs voices: 2\n\n" +
        "- Claudia · general\n" +
        "  id: voice-a\n\n" +
        "(showing first 1)",
    });
  });

  it("does not coerce partial voice list limits", async () => {
    const { command, runtime } = createHarness(talkConfig("elevenlabs", { apiKey: "sk-eleven" }));
    vi.mocked(runtime.tts.listVoices).mockResolvedValue(
      Array.from({ length: 13 }, (_, index) => ({
        id: `voice-${index}`,
        name: `Voice ${index}`,
      })),
    );

    const result = await command.handler(createCommandContext("list 1x"));

    expect(result.text).toContain("(showing first 12)");
  });

  it("surfaces richer provider voice metadata when available", async () => {
    const { command, runtime } = createHarness(talkConfig("microsoft"));
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([
      {
        id: "en-US-AvaNeural",
        name: "Ava",
        category: "General",
        locale: "en-US",
        gender: "Female",
        personalities: ["Friendly", "Positive"],
        description: "Friendly, Positive",
      },
    ]);

    const result = await command.handler(createCommandContext("list"));

    expect(result).toEqual({
      text:
        "Microsoft voices: 1\n\n" +
        "- Ava · General\n" +
        "  id: en-US-AvaNeural\n" +
        "  meta: en-US · Female · Friendly, Positive\n" +
        "  note: Friendly, Positive",
    });
  });

  it("writes only canonical provider-scoped voice config for elevenlabs", async () => {
    const { command, runtime } = createHarness(talkConfig("elevenlabs", { apiKey: "sk-eleven" }));
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "voice-a", name: "Claudia" }]);

    const result = await command.handler(
      createCommandContext("set Claudia", "webchat", ["operator.admin"]),
    );

    expect(runtime.config.mutateConfigFile).toHaveBeenCalledWith({
      afterWrite: { mode: "auto" },
      writeOptions: { assertCurrent: undefined },
      mutate: expect.any(Function),
    });
    expect(runtime.config.current()).toStrictEqual({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "sk-eleven",
            voiceId: "voice-a",
          },
        },
      },
    });
    expect(result).toEqual({
      text: "✅ ElevenLabs Talk voice set to Claudia\nvoice-a",
    });
  });

  it.each([
    { channel: "telegram", scopes: ["operator.write"] },
    { channel: "discord", scopes: undefined },
  ])("rejects unauthorized voice writes on $channel", async ({ channel, scopes }) => {
    const { runtime, run } = createElevenlabsVoiceSetHarness(channel, scopes);
    const result = await run();

    expect(result.text).toContain("requires operator.admin");
    expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("keeps read-only voice commands available without operator.admin", async () => {
    const { command, runtime } = createHarness(talkConfig("elevenlabs", { apiKey: "sk-eleven" }));
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "voice-a", name: "Claudia" }]);

    const status = await command.handler(createCommandContext("status", "telegram"));
    const list = await command.handler(createCommandContext("list", "telegram"));

    expect(status.text).toContain("Talk voice status:");
    expect(list.text).toContain("ElevenLabs voices: 1");
    expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("allows /voice set from an owner non-gateway channel without scopes", async () => {
    const { command, runtime } = createHarness(talkConfig("elevenlabs", { apiKey: "sk-eleven" }));
    expect(command.exposeSenderIsOwner).toBe(true);
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "voice-a", name: "Claudia" }]);

    const result = await command.handler(
      createCommandContext("set Claudia", "telegram", undefined, true),
    );

    expect(runtime.config.mutateConfigFile).toHaveBeenCalled();
    expect(result.text).toContain("voice-a");
  });

  it("returns provider lookup errors cleanly", async () => {
    const { command, runtime } = createHarness(talkConfig("microsoft"));
    vi.mocked(runtime.tts.listVoices).mockRejectedValue(
      new Error("speech provider microsoft does not support voice listing"),
    );

    const result = await command.handler(createCommandContext("list"));

    expect(result).toEqual({
      text: "Microsoft voice list failed: speech provider microsoft does not support voice listing",
    });
  });
});
