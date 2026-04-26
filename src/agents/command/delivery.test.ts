import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import * as channelPluginsModule from "../../channels/plugins/index.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import * as agentDeliveryModule from "../../infra/outbound/agent-delivery.js";
import type { AgentDeliveryPlan } from "../../infra/outbound/agent-delivery.js";
import * as deliverModule from "../../infra/outbound/deliver.js";
import type { OutboundDeliveryResult } from "../../infra/outbound/deliver.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import * as messageChannelModule from "../../utils/message-channel.js";
import { deliverAgentCommandResult, normalizeAgentCommandReplyPayloads } from "./delivery.js";
import type { AgentCommandOpts } from "./types.js";

const deliverOutboundPayloadsMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => [] as unknown[]),
);
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
}));

const createReplyMediaPathNormalizerMock = vi.hoisted(() =>
  vi.fn(
    (..._args: unknown[]) =>
      (payload: ReplyPayload) =>
        Promise.resolve(payload),
  ),
);
vi.mock("../../auto-reply/reply/reply-media-paths.runtime.js", () => ({
  createReplyMediaPathNormalizer: createReplyMediaPathNormalizerMock,
}));

type NormalizeParams = Parameters<typeof normalizeAgentCommandReplyPayloads>[0];
type RunResult = NormalizeParams["result"];
type DeliverParams = Parameters<typeof deliverAgentCommandResult>[0];

const slackOutboundForTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ to, text }) => ({
    channel: "slack",
    messageId: `${to}:${text}`,
  }),
};

const emptyRegistry = createTestRegistry([]);
const slackRegistry = createTestRegistry([
  {
    pluginId: "slack",
    source: "test",
    plugin: createOutboundTestPlugin({
      id: "slack",
      outbound: slackOutboundForTest,
      messaging: {
        enableInteractiveReplies: ({ cfg }) =>
          (cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } } | undefined)
            ?.capabilities?.interactiveReplies === true,
      },
    }),
  },
]);

function createResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    meta: {
      durationMs: 1,
      ...overrides.meta,
    },
    ...(overrides.payloads ? { payloads: overrides.payloads } : {}),
  } as RunResult;
}

async function deliverMediaReplyForTest(outboundSession: DeliverParams["outboundSession"]) {
  const runtime = { log: vi.fn(), error: vi.fn() };
  return await deliverAgentCommandResult({
    cfg: {
      agents: {
        list: [{ id: "tester", workspace: "/tmp/agent-workspace" }],
      },
    } as OpenClawConfig,
    deps: {} as CliDeps,
    runtime: runtime as never,
    opts: {
      message: "go",
      deliver: true,
      replyChannel: "slack",
      replyTo: "#general",
    } as AgentCommandOpts,
    outboundSession,
    sessionEntry: undefined,
    payloads: [{ text: "here you go", mediaUrls: ["./out/photo.png"] }],
    result: createResult(),
  });
}

describe("normalizeAgentCommandReplyPayloads", () => {
  beforeEach(() => {
    setActivePluginRegistry(slackRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("keeps Slack directives in text for direct agent deliveries", () => {
    const normalized = normalizeAgentCommandReplyPayloads({
      cfg: {
        channels: {
          slack: {
            capabilities: { interactiveReplies: true },
          },
        },
      } as OpenClawConfig,
      opts: { message: "test" } as AgentCommandOpts,
      outboundSession: undefined,
      deliveryChannel: "slack",
      payloads: [{ text: "Choose [[slack_buttons: Retry:retry]]" }],
      result: createResult(),
    });

    expect(normalized).toMatchObject([
      {
        text: "Choose [[slack_buttons: Retry:retry]]",
      },
    ]);
  });

  it("renders response prefix templates with the selected runtime model", () => {
    const normalized = normalizeAgentCommandReplyPayloads({
      cfg: {
        messages: {
          responsePrefix: "[{modelFull}]",
        },
      } as OpenClawConfig,
      opts: { message: "test" } as AgentCommandOpts,
      outboundSession: undefined,
      deliveryChannel: "slack",
      payloads: [{ text: "Ready." }],
      result: createResult({
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "session-1",
            provider: "openai-codex",
            model: "gpt-5.4",
          },
        },
      }),
    });

    expect(normalized).toMatchObject([
      {
        text: "[openai-codex/gpt-5.4] Ready.",
      },
    ]);
  });

  it("keeps Slack options text intact for local preview when delivery is disabled", async () => {
    const runtime = {
      log: vi.fn(),
    };

    const delivered = await deliverAgentCommandResult({
      cfg: {
        channels: {
          slack: {
            capabilities: { interactiveReplies: true },
          },
        },
      } as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
        channel: "slack",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Options: on, off." }],
      result: createResult(),
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith("Options: on, off.");
    expect(delivered.payloads).toMatchObject([{ text: "Options: on, off." }]);
  });

  it("normalizes reply-media paths before outbound delivery", async () => {
    const normalizerFn = vi.fn(
      async (payload: ReplyPayload): Promise<ReplyPayload> => ({
        ...payload,
        mediaUrl: "/tmp/agent-workspace/out/photo.png",
        mediaUrls: ["/tmp/agent-workspace/out/photo.png"],
      }),
    );
    createReplyMediaPathNormalizerMock.mockReturnValue(normalizerFn);
    deliverOutboundPayloadsMock.mockResolvedValue([]);

    await deliverMediaReplyForTest({
      key: "agent:tester:slack:direct:alice",
      agentId: "tester",
    } as never);

    expect(createReplyMediaPathNormalizerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:tester:slack:direct:alice",
        agentId: "tester",
        workspaceDir: "/tmp/agent-workspace",
        messageProvider: "slack",
      }),
    );
    expect(normalizerFn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrls: ["./out/photo.png"] }),
    );
    expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
    const [firstCallArg] = deliverOutboundPayloadsMock.mock.calls[0] ?? [];
    const deliverArgs = firstCallArg as { payloads: ReplyPayload[] } | undefined;
    expect(deliverArgs?.payloads[0]).toMatchObject({
      mediaUrls: ["/tmp/agent-workspace/out/photo.png"],
    });
  });

  it("threads agentId into the normalizer when sessionKey is unresolved", async () => {
    createReplyMediaPathNormalizerMock.mockReturnValue(async (payload: ReplyPayload) => payload);
    deliverOutboundPayloadsMock.mockResolvedValue([]);

    await deliverMediaReplyForTest({ agentId: "tester" } as never);

    expect(createReplyMediaPathNormalizerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "tester",
        sessionKey: undefined,
        workspaceDir: "/tmp/agent-workspace",
      }),
    );
  });

  it("keeps LINE directive-only replies intact for local preview when delivery is disabled", async () => {
    const runtime = {
      log: vi.fn(),
    };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
        channel: "line",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [
        {
          text: "[[buttons: Release menu | Choose an action | Retry:retry, Ignore:ignore]]",
        },
      ],
      result: createResult(),
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      "[[buttons: Release menu | Choose an action | Retry:retry, Ignore:ignore]]",
    );
    expect(delivered.payloads).toMatchObject([
      {
        text: "[[buttons: Release menu | Choose an action | Retry:retry, Ignore:ignore]]",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// deliveryStatus tracking tests (PR #53961)
// Uses spyOn approach for delivery mocking — separate from upstream normalize tests.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Spies (vi.mock has module-resolution issues in forks pool when transitive
// dependencies are pre-loaded by test/setup.ts — vi.spyOn is reliable).
// ---------------------------------------------------------------------------

const deliverSpy = vi.spyOn(deliverModule, "deliverOutboundPayloads");
const deliveryPlanSpy = vi.spyOn(agentDeliveryModule, "resolveAgentDeliveryPlan");
const outboundTargetSpy = vi.spyOn(agentDeliveryModule, "resolveAgentOutboundTarget");
const channelPluginSpy = vi.spyOn(channelPluginsModule, "getChannelPlugin");
const isInternalSpy = vi.spyOn(messageChannelModule, "isInternalMessageChannel");

afterAll(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRuntime(): RuntimeEnv & {
  log: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv & {
    log: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

/** Set up spies for a standard successful Discord delivery. */
function setupSuccessfulDelivery() {
  deliverSpy.mockResolvedValue([
    { channel: "discord", messageId: "msg-1" } as OutboundDeliveryResult,
  ]);
  deliveryPlanSpy.mockReturnValue({
    baseDelivery: {} as unknown as AgentDeliveryPlan["baseDelivery"],
    resolvedChannel: "discord",
    resolvedTo: "channel:123456",
    resolvedAccountId: "bot-1",
  });
  outboundTargetSpy.mockReturnValue({
    resolvedTarget: {
      ok: true as const,
      to: "channel:123456",
    } as ReturnType<typeof agentDeliveryModule.resolveAgentOutboundTarget>["resolvedTarget"],
    resolvedTo: "channel:123456",
    targetMode: "explicit" as const,
  });
  channelPluginSpy.mockReturnValue({ name: "discord" } as unknown as ReturnType<
    typeof channelPluginsModule.getChannelPlugin
  >);
  isInternalSpy.mockReturnValue(false);
}

async function runDelivery(
  opts: Record<string, unknown>,
  overrides?: { runtime?: ReturnType<typeof createRuntime> },
) {
  const runtime = overrides?.runtime ?? createRuntime();
  const result = await deliverAgentCommandResult({
    cfg: {} as unknown as OpenClawConfig,
    deps: {} as unknown as CliDeps,
    runtime,
    opts: opts as unknown as AgentCommandOpts,
    outboundSession: { key: "agent:main:discord:direct:12345" },
    sessionEntry: {
      lastChannel: "discord",
      lastTo: "channel:123456",
    } as unknown as SessionEntry,
    result: { payloads: [{ text: "hello" }], meta: { durationMs: 1 } },
    payloads: [{ text: "hello" }],
  });
  return { runtime, result };
}

function logMessages(runtime: ReturnType<typeof createRuntime>): string[] {
  return runtime.log.mock.calls.map((c: unknown[]) => String(c[0]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deliverAgentCommandResult — delivery status tracking", () => {
  beforeEach(() => {
    // Clear call counts/results but keep spies attached (vi.restoreAllMocks
    // would disconnect them from the module exports).
    deliverSpy.mockReset();
    deliveryPlanSpy.mockReset();
    outboundTargetSpy.mockReset();
    channelPluginSpy.mockReset();
    isInternalSpy.mockReset();
    setupSuccessfulDelivery();
  });

  it("returns deliveryStatus.succeeded=true on successful delivery", async () => {
    const { result, runtime } = await runDelivery({
      message: "hello",
      deliver: true,
      channel: "discord",
      to: "channel:123456",
    });

    expect(deliverSpy).toHaveBeenCalledOnce();
    expect(result.deliveryStatus).toEqual({
      requested: true,
      attempted: true,
      succeeded: true,
    });
    // No warning log on success
    expect(logMessages(runtime).some((msg) => msg.includes("[delivery]"))).toBe(false);
  });

  it("returns no deliveryStatus when deliver is false", async () => {
    const { result } = await runDelivery({
      message: "hello",
      deliver: false,
    });

    expect(deliverSpy).not.toHaveBeenCalled();
    expect(result.deliveryStatus).toBeUndefined();
  });

  it("logs warning and returns succeeded=false when delivery target is missing", async () => {
    outboundTargetSpy.mockReturnValue({
      resolvedTarget: null,
      resolvedTo: undefined,
      targetMode: "implicit" as const,
    });

    const { result, runtime } = await runDelivery({
      message: "hello",
      deliver: true,
      channel: "discord",
    });

    expect(deliverSpy).not.toHaveBeenCalled();
    expect(result.deliveryStatus).toEqual({
      requested: true,
      attempted: false,
      succeeded: false,
    });
    expect(
      logMessages(runtime).some((msg) =>
        msg.includes("[delivery] delivery requested but not completed"),
      ),
    ).toBe(true);
  });

  it("logs warning and returns succeeded=false when deliverOutboundPayloads returns empty", async () => {
    deliverSpy.mockResolvedValue([]);

    const { result, runtime } = await runDelivery({
      message: "hello",
      deliver: true,
      channel: "discord",
      to: "channel:123456",
    });

    expect(deliverSpy).toHaveBeenCalledOnce();
    expect(result.deliveryStatus).toEqual({
      requested: true,
      attempted: true,
      succeeded: false,
    });
    expect(logMessages(runtime).some((msg) => msg.includes("delivery returned zero results"))).toBe(
      true,
    );
  });

  it("catches thrown error in bestEffort mode without re-throwing", async () => {
    deliverSpy.mockRejectedValue(new Error("Discord API timeout"));

    const { result, runtime } = await runDelivery({
      message: "hello",
      deliver: true,
      bestEffortDeliver: true,
      channel: "discord",
      to: "channel:123456",
    });

    expect(result.deliveryStatus).toEqual({
      requested: true,
      attempted: true,
      succeeded: false,
      error: true,
    });
    // Error should be logged via logDeliveryError -> runtime.error or runtime.log
    const allOutput = [...runtime.error.mock.calls, ...runtime.log.mock.calls].map((c) =>
      String(c[0]),
    );
    expect(allOutput.some((msg) => msg.includes("Discord API timeout"))).toBe(true);
    // Structured log should report "threw an error", not "zero results"
    expect(allOutput.some((msg) => msg.includes("delivery threw an error"))).toBe(true);
  });

  it("re-throws error when bestEffort is false", async () => {
    deliverSpy.mockRejectedValue(new Error("Discord API timeout"));

    await expect(
      runDelivery({
        message: "hello",
        deliver: true,
        bestEffortDeliver: false,
        channel: "discord",
        to: "channel:123456",
      }),
    ).rejects.toThrow("Discord API timeout");
  });

  it("returns deliveryStatus on early return when deliver=true but no payloads", async () => {
    const runtime = createRuntime();
    const result = await deliverAgentCommandResult({
      cfg: {} as unknown as OpenClawConfig,
      deps: {} as unknown as CliDeps,
      runtime,
      opts: {
        message: "hello",
        deliver: true,
        channel: "discord",
        to: "channel:123456",
      } as unknown as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      result: { payloads: [], meta: { durationMs: 1 } },
      payloads: [],
    });

    expect(result.deliveryStatus).toEqual({
      requested: true,
      attempted: false,
      succeeded: false,
    });
    expect(logMessages(runtime)).toContain("No reply from agent.");
  });

  it("returns no deliveryStatus on early return when deliver=false and no payloads", async () => {
    const runtime = createRuntime();
    const result = await deliverAgentCommandResult({
      cfg: {} as unknown as OpenClawConfig,
      deps: {} as unknown as CliDeps,
      runtime,
      opts: {
        message: "hello",
        deliver: false,
      } as unknown as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      result: { payloads: [], meta: { durationMs: 1 } },
      payloads: [],
    });

    expect(result.deliveryStatus).toBeUndefined();
  });

  it("returns succeeded=true with hadPartialFailure when onError fires but results exist", async () => {
    deliverSpy.mockImplementation(async (opts) => {
      // Simulate partial failure: onError fires for one payload, but results still returned
      opts.onError?.(new Error("Payload 2 failed"), { text: "hello" } as never);
      return [{ channel: "discord", messageId: "msg-1" } as OutboundDeliveryResult];
    });

    const { result, runtime } = await runDelivery({
      message: "hello",
      deliver: true,
      channel: "discord",
      to: "channel:123456",
    });

    expect(result.deliveryStatus).toEqual({
      requested: true,
      attempted: true,
      succeeded: true,
      hadPartialFailure: true,
    });
    // No [delivery] warning — succeeded is true
    expect(logMessages(runtime).some((msg) => msg.includes("[delivery]"))).toBe(false);
  });

  it("logs warning when channel resolves to internal", async () => {
    isInternalSpy.mockReturnValue(true);
    deliveryPlanSpy.mockReturnValue({
      baseDelivery: {} as unknown as AgentDeliveryPlan["baseDelivery"],
      resolvedChannel: "__internal__",
      resolvedTo: undefined,
    });

    const { result, runtime } = await runDelivery({
      message: "hello",
      deliver: true,
      bestEffortDeliver: true,
    });

    expect(deliverSpy).not.toHaveBeenCalled();
    expect(result.deliveryStatus).toEqual({
      requested: true,
      attempted: false,
      succeeded: false,
      error: true,
    });
    expect(logMessages(runtime).some((msg) => msg.includes("channel resolved to internal"))).toBe(
      true,
    );
  });

  it("includes deliveryStatus in JSON output when deliver=true", async () => {
    const { result, runtime } = await runDelivery({
      message: "hello",
      deliver: true,
      json: true,
      channel: "discord",
      to: "channel:123456",
    });

    expect(result.deliveryStatus).toEqual({
      requested: true,
      attempted: true,
      succeeded: true,
    });
    // JSON output should include deliveryStatus
    const jsonOutput = logMessages(runtime).find((msg) => msg.startsWith("{"));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.deliveryStatus).toEqual({
      requested: true,
      attempted: true,
      succeeded: true,
    });
  });

  it("omits deliveryStatus from JSON output when deliver=false", async () => {
    const runtime = createRuntime();
    isInternalSpy.mockReturnValue(false);
    channelPluginSpy.mockReturnValue({ name: "discord" } as unknown as ReturnType<
      typeof channelPluginsModule.getChannelPlugin
    >);
    await deliverAgentCommandResult({
      cfg: {} as unknown as OpenClawConfig,
      deps: {} as unknown as CliDeps,
      runtime,
      opts: {
        message: "hello",
        deliver: false,
        json: true,
        channel: "discord",
      } as unknown as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      result: { payloads: [{ text: "hello" }], meta: { durationMs: 1 } },
      payloads: [{ text: "hello" }],
    });

    const jsonOutput = logMessages(runtime).find((msg) => msg.startsWith("{"));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.deliveryStatus).toBeUndefined();
  });
});
