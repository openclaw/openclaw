import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import { vi } from "vitest";
import type { setGoogleChatWebhookEventProcessor } from "./monitor-routing.js";
import type { WebhookTarget } from "./monitor-types.js";
import "./monitor.js";

type EventProcessor = Parameters<typeof setGoogleChatWebhookEventProcessor>[0];
type Delivery = ChannelInboundTurnPlan["delivery"];
type RunDelivery = (delivery: Delivery) => Promise<void>;
const routing = vi.hoisted<{ processEvent?: EventProcessor }>(() => ({}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  createChannelInboundEnvelopeBuilderAsync:
    async () =>
    ({ body }: { body: string }) =>
      body,
}));

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/routing")>()),
  resolveAgentRoute: ({ accountId }: { accountId: string }) => ({
    agentId: "agent-1",
    accountId,
    sessionKey: "session-1",
  }),
}));

vi.mock("./monitor-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor-access.js")>()),
  applyGoogleChatInboundAccessPolicy: async () => ({ ok: true }),
}));

// mock-isolation: capture the real processor without registering shared webhook state.
vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: (processEvent: EventProcessor) => {
    routing.processEvent = processEvent;
  },
}));

export function createGoogleChatReplyDeliveryHarness() {
  let runDelivery: RunDelivery | undefined;
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: {
        buildContext: (payload: unknown) => payload,
        run: async (turn: {
          adapter: { resolveTurn: () => ChannelInboundTurnPlan | Promise<ChannelInboundTurnPlan> };
        }) => {
          if (!runDelivery) {
            throw new Error("Expected Google Chat delivery fixture runner");
          }
          const resolved = await turn.adapter.resolveTurn();
          await runDelivery(resolved.delivery);
        },
      },
    },
  };
  return {
    core,
    process: async (
      target: Pick<WebhookTarget, "account" | "config" | "runtime" | "core" | "statusSink">,
      run: RunDelivery,
    ) => {
      if (!routing.processEvent) {
        throw new Error("Expected Google Chat webhook event processor registration");
      }
      runDelivery = run;
      try {
        await routing.processEvent(
          {
            type: "MESSAGE",
            space: { name: "spaces/AAA", spaceType: "SPACE" },
            message: {
              name: "spaces/AAA/messages/inbound",
              text: "hello",
              thread: { name: "spaces/AAA/threads/root" },
              sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
            },
          },
          {
            ...target,
            mediaMaxMb: 10,
            path: "/googlechat",
            ingress: { receive: vi.fn<WebhookTarget["ingress"]["receive"]>() },
          },
        );
      } finally {
        runDelivery = undefined;
      }
    },
  };
}
