// Covers queueCustody propagation from durable send failures through deliverAgentCommandResult.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelOutboundAdapter,
  ChannelThreadingAdapter,
} from "../../channels/plugins/types.public.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import { OutboundDeliveryError } from "../../infra/outbound/deliver-types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverAgentCommandResult } from "./delivery.js";
import type { AgentCommandOpts } from "./types.js";

const deliverOutboundPayloadsMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => [] as unknown[]),
);
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
  deliverOutboundPayloadsInternal: deliverOutboundPayloadsMock,
}));

vi.mock("../../auto-reply/reply/reply-media-paths.runtime.js", () => ({
  createReplyMediaPathNormalizer: vi.fn(
    (..._args: unknown[]) =>
      (payload: unknown) =>
        Promise.resolve(payload),
  ),
}));

type DeliverParams = Parameters<typeof deliverAgentCommandResult>[0];
type RunResult = DeliverParams["result"];

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
    plugin: {
      ...createOutboundTestPlugin({ id: "slack", outbound: slackOutboundForTest }),
      threading: {
        resolveReplyTransport: () => ({ replyToId: undefined, threadId: null }),
      } as ChannelThreadingAdapter,
    },
  },
]);

function createResult(): RunResult {
  return { meta: { durationMs: 1 } } as RunResult;
}

function runDelivery(error: OutboundDeliveryError) {
  deliverOutboundPayloadsMock.mockRejectedValueOnce(error);
  const onDeliveryResult = vi.fn();
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
  const run = deliverAgentCommandResult({
    cfg: {
      agents: { list: [{ id: "tester", workspace: "/tmp/agent-workspace" }] },
    } as OpenClawConfig,
    deps: {} as CliDeps,
    runtime: runtime as never,
    opts: {
      message: "go",
      deliver: true,
      json: true,
      bestEffortDeliver: false,
      replyChannel: "slack",
      replyTo: "#general",
    } as AgentCommandOpts,
    outboundSession: {
      key: "agent:tester:slack:direct:alice",
      agentId: "tester",
    } as never,
    sessionEntry: undefined,
    payloads: [{ text: "here you go" }],
    result: createResult(),
    onDeliveryResult,
  });
  return { run, onDeliveryResult };
}

describe("deliverAgentCommandResult queueCustody propagation", () => {
  beforeEach(() => {
    setActivePluginRegistry(slackRegistry);
    deliverOutboundPayloadsMock.mockReset();
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it.each([
    { queueCustody: "held" as const, expected: "held" },
    { queueCustody: "released" as const, expected: undefined },
    { queueCustody: undefined, expected: undefined },
  ])(
    "propagates queueCustody=$queueCustody as $expected on a strict failed durable send",
    async ({ queueCustody, expected }) => {
      const failedError = new OutboundDeliveryError("Slack API timeout", {
        cause: new Error("Slack API timeout"),
        results: [],
      });
      failedError.queueCustody = queueCustody;
      const { run, onDeliveryResult } = runDelivery(failedError);

      await expect(run).rejects.toThrow("Slack API timeout");

      const status = onDeliveryResult.mock.calls[0]?.[0]?.deliveryStatus;
      expect(status?.status).toBe("failed");
      expect(status?.queueCustody).toBe(expected);
    },
  );

  it("preserves held queueCustody on a strict partial_failed durable send", async () => {
    const heldPartialFailedError = new OutboundDeliveryError("Slack API timeout", {
      cause: new Error("Slack API timeout"),
      results: [{ channel: "slack", messageId: "msg-1" }],
    });
    heldPartialFailedError.queueCustody = "held";
    const { run, onDeliveryResult } = runDelivery(heldPartialFailedError);

    await expect(run).rejects.toThrow("Slack API timeout");

    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryStatus: expect.objectContaining({
          status: "partial_failed",
          queueCustody: "held",
        }),
      }),
    );
  });
});
