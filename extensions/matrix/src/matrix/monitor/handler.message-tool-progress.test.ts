import path from "node:path";
import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  runChannelInboundEvent,
  type ChannelInboundEventRunnerParams,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { FinalizedMsgContext, GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixMonitorHandlerParams } from "./handler-types.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixIngressLifecycle,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

type MatrixInboundRun = MatrixMonitorHandlerParams["core"]["channel"]["inbound"]["run"];

const sendDraftMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "$draft1", roomId: "!room" })),
);
const sendMock = vi.hoisted(() => vi.fn());

// mock-isolation: Keep Matrix network sends inert while core dispatch decides progress delivery.
vi.mock("../send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.js")>()),
  sendMessageMatrix: sendMock,
  sendSingleTextMessageMatrix: sendDraftMock,
  sendTypingMatrix: vi.fn(async () => {}),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Matrix progress when the message tool sends the final reply", () => {
  it("shows the progress draft through core dispatch without automatic final delivery", async () => {
    installMatrixMonitorTestRuntime();
    const cfg = {
      session: { store: path.join(tempDirs.make("openclaw-matrix-progress-"), "sessions.json") },
      messages: { visibleReplies: "message_tool" },
      channels: { matrix: { dm: { allowFrom: ["*"] } } },
    } satisfies OpenClawConfig;
    const runWithProgressResolver = (async (params: Parameters<MatrixInboundRun>[0]) => {
      const adapter = params.adapter;
      return await runChannelInboundEvent({
        ...params,
        adapter: {
          ...adapter,
          resolveTurn: async (...args: Parameters<typeof adapter.resolveTurn>) => {
            const turn = await adapter.resolveTurn(...args);
            if (!("route" in turn) || "runDispatch" in turn) {
              throw new Error("expected Matrix to resolve a routed channel turn");
            }
            return {
              ...turn,
              replyResolver: (async (_ctx: FinalizedMsgContext, options?: GetReplyOptions) => {
                await options?.onItemEvent?.(
                  projectAgentToolActivity({
                    toolCallId: "read-1",
                    name: "read_file",
                    phase: "start",
                  }),
                );
                await vi.waitFor(() => expect(sendDraftMock).toHaveBeenCalledTimes(1), {
                  timeout: 10_000,
                });
                return undefined;
              }) as never,
            };
          },
        },
      } as ChannelInboundEventRunnerParams<MatrixRawEvent>);
    }) as MatrixInboundRun;
    const runtime = { error: vi.fn() };
    const { handler } = createMatrixHandlerTestHarness({
      cfg,
      runtime: runtime as never,
      streaming: "progress",
      previewToolProgressEnabled: true,
      runChannelInboundEvent: runWithProgressResolver,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$progress", body: "check the file" }),
      createMatrixIngressLifecycle(),
    );

    expect(runtime.error).not.toHaveBeenCalled();
    expect(sendDraftMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
