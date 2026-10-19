import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "./api.js";
import register from "./index.js";

const gatewayMocks = vi.hoisted(() => ({ callGatewayTool: vi.fn() }));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => gatewayMocks);

function createHarness(initialConfig: Record<string, unknown>, voices?: SpeechVoiceOption[]) {
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
    registerTool: vi.fn((definition: AnyAgentTool | OpenClawPluginToolFactory) => {
      const created =
        typeof definition === "function"
          ? definition({ sessionKey: "agent:main:main" })
          : definition;
      if (!created || Array.isArray(created)) {
        throw new Error("talk-voice requires one tool");
      }
      tool = created;
    }),
  };
  register.register(api as never);
  if (!command || !tool) {
    throw new Error("talk-voice command or tool not registered");
  }
  const registeredCommand = command;
  const listVoices = vi.mocked(runtime.tts.listVoices);
  if (voices) {
    listVoices.mockResolvedValue(voices);
  }
  return {
    command,
    tool,
    runtime,
    listVoices,
    mutate: runtime.config.mutateConfigFile,
    run: (...args: Parameters<typeof createCommandContext>) =>
      registeredCommand.handler(createCommandContext(...args)),
  };
}

function talkConfig(provider: string, config: Record<string, unknown> = {}) {
  return { talk: { provider, providers: { [provider]: config } } };
}

const claudia = [{ id: "voice-a", name: "Claudia" }];
const elevenlabs = talkConfig("elevenlabs", { apiKey: "sk-eleven" });

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
      const { command, runtime, listVoices } = createHarness(initialConfig);
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
      listVoices.mockImplementationOnce(async () => {
        current = false;
        ctx.assertOwnerCurrent = () => {};
        return [{ id: "en-US-AvaNeural", name: "Ava" }];
      });
      const pending = command.handler(ctx);
      if (gatewayAdmin) {
        await expect(pending).resolves.toMatchObject({
          text: expect.stringContaining("Talk voice set to Ava"),
        });
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
        .then((result) => {
          completed();
          return result;
        });

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

  it("does not coerce partial voice list limits", async () => {
    const { run } = createHarness(
      elevenlabs,
      Array.from({ length: 13 }, (_, index) => ({
        id: `voice-${index}`,
        name: `Voice ${index}`,
      })),
    );

    expect((await run("list 1x")).text).toContain("(showing first 12)");
  });

  it("surfaces richer provider voice metadata when available", async () => {
    const { run } = createHarness(talkConfig("microsoft"), [
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

    expect(await run("list")).toEqual({
      text: `Microsoft voices: 1

- Ava · General
  id: en-US-AvaNeural
  meta: en-US · Female · Friendly, Positive
  note: Friendly, Positive`,
    });
  });

  it.each([
    { channel: "telegram", scopes: ["operator.write"] },
    { channel: "discord", scopes: undefined },
  ])("rejects unauthorized voice writes on $channel", async ({ channel, scopes }) => {
    const { mutate, run } = createHarness(elevenlabs, claudia);
    const result = await run("set Claudia", channel, scopes);
    expect(result.text).toContain("requires operator.admin");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps read-only voice commands available without operator.admin", async () => {
    const { mutate, run } = createHarness(elevenlabs, claudia);
    const status = await run("status", "telegram");
    const list = await run("list", "telegram");
    expect(status.text).toContain("Talk voice status:");
    expect(list.text).toContain("ElevenLabs voices: 1");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("allows /voice set from an owner non-gateway channel without scopes", async () => {
    const { command, mutate, run } = createHarness(elevenlabs, claudia);
    expect(command.exposeSenderIsOwner).toBe(true);
    const result = await run("set Claudia", "telegram", undefined, true);
    expect(mutate).toHaveBeenCalled();
    expect(result.text).toContain("voice-a");
  });

  it("returns provider lookup errors cleanly", async () => {
    const { run, listVoices } = createHarness(talkConfig("microsoft"));
    listVoices.mockRejectedValue(
      new Error("speech provider microsoft does not support voice listing"),
    );

    expect(await run("list")).toEqual({
      text: "Microsoft voice list failed: speech provider microsoft does not support voice listing",
    });
  });
});
