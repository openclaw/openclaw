import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverAgentCommandResult, normalizeAgentCommandReplyPayloads } from "./delivery.js";
import type { AgentCommandOpts } from "./types.js";

const emittedDiagnostics = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../../infra/continuity-diagnostics.js", () => ({
  emitContinuityDiagnostic: vi.fn((params: Record<string, unknown>) => {
    emittedDiagnostics.push(params);
    return params;
  }),
}));

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

const tempDirs: string[] = [];

async function createSessionStoreForTest(entries: Record<string, SessionEntry>): Promise<{
  dir: string;
  storePath: string;
  cfg: OpenClawConfig;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-delivery-store-"));
  tempDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(entries), "utf8");
  return {
    dir,
    storePath,
    cfg: {
      session: { scope: "global", mainKey: "main", store: storePath },
      agents: { list: [{ id: "tester", workspace: "/tmp/agent-workspace" }] },
    } as OpenClawConfig,
  };
}

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
    emittedDiagnostics.length = 0;
    deliverOutboundPayloadsMock.mockClear();
    createReplyMediaPathNormalizerMock.mockClear();
    setActivePluginRegistry(slackRegistry);
  });

  afterEach(async () => {
    setActivePluginRegistry(emptyRegistry);
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
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

  it("re-resolves outbound target from the live session entry before delivery", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([]);
    const runtime = { log: vi.fn(), error: vi.fn() };
    const now = Date.now();
    const { cfg } = await createSessionStoreForTest({
      global: {
        sessionId: "session-live",
        updatedAt: now,
        lastChannel: "slack",
        lastTo: "#live",
      } as SessionEntry,
    });

    await deliverAgentCommandResult({
      cfg,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
        deliver: true,
      } as AgentCommandOpts,
      outboundSession: { key: "main", agentId: "tester" } as never,
      sessionEntry: {
        sessionId: "session-live",
        updatedAt: now - 1,
        lastChannel: "slack",
        lastTo: "#carried",
      } as SessionEntry,
      payloads: [{ text: "Ready." }],
      result: createResult(),
    });

    const [deliverArgs] = deliverOutboundPayloadsMock.mock.calls[0] ?? [];
    expect(deliverArgs).toMatchObject({ channel: "slack", to: "#live" });
    expect(emittedDiagnostics).toContainEqual(
      expect.objectContaining({
        type: "diag.outbound.target_reresolved",
        severity: "warn",
        phase: "before_delivery",
      }),
    );
  });

  it("uses restored boundary delivery metadata as a transient fallback", async () => {
    const runtime = { log: vi.fn() };
    const entry = {
      sessionId: "session-restored",
      updatedAt: Date.now(),
      continuityRestore: {
        usedBoundary: {
          type: "continuity.restore.used_boundary",
          checkpointId: "checkpoint-1",
          boundaryId: "compact-boundary:test",
          restoredAt: Date.now(),
          boundaryMetadata: {
            version: 1,
            type: "compact.boundary",
            boundaryId: "compact-boundary:test",
            createdAt: Date.now(),
            state: {
              sessionBinding: { channel: "slack", accountId: "account-1", threadId: "thread-1" },
              approval: { captured: false, reason: "captured elsewhere" },
              outbound: { channel: "slack", targetId: "#restored", threadId: "thread-1" },
              children: { pendingDescendantState: "live-query-required" },
              policy: {},
            },
          },
        },
      },
    } as SessionEntry;

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
      } as AgentCommandOpts,
      outboundSession: { key: "main", agentId: "tester" } as never,
      sessionEntry: entry,
      payloads: [{ text: "Preview." }],
      result: createResult(),
    });

    expect(runtime.log).toHaveBeenCalledWith("Preview.");
    expect(delivered.payloads).toMatchObject([{ text: "Preview." }]);
    expect(entry.lastChannel).toBeUndefined();
    expect(emittedDiagnostics).toContainEqual(
      expect.objectContaining({
        type: "continuity.restore.boundary_fallback_applied",
        severity: "info",
        phase: "before_delivery",
        correlation: expect.objectContaining({
          boundaryId: "compact-boundary:test",
          checkpointId: "checkpoint-1",
          planSource: "carried",
        }),
        details: expect.objectContaining({
          appliedFields: ["channel", "to", "accountId", "threadId"],
        }),
      }),
    );
  });
});
