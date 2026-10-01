import { beforeAll, describe, expect, it, vi } from "vitest";
import { approvalButtonBlocks, createContext } from "./interactions.test-support.js";

const readSlackMessagesMock = vi.hoisted(() =>
  vi.fn<typeof import("../../actions.js").readSlackMessages>(),
);
const resolveApprovalOverGatewayMock = vi.hoisted(() =>
  vi.fn(async (_arg: unknown) => ({
    applied: true,
    approval: {
      status: "allowed" as const,
      decision: "allow-once" as const,
      presentation: { kind: "plugin" as const },
    },
  })),
);

vi.mock("../../actions.js", () => ({ readSlackMessages: readSlackMessagesMock }));
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: (arg: unknown) => resolveApprovalOverGatewayMock(arg),
}));

let registerSlackInteractionEvents: typeof import("./interactions.js").registerSlackInteractionEvents;

describe("Slack plugin approval reviewer identity", () => {
  beforeAll(async () => {
    ({ registerSlackInteractionEvents } = await import("./interactions.js"));
  });

  it("sends a workspace-qualified reviewer for plugin buttons on workspace installs", async () => {
    readSlackMessagesMock.mockResolvedValueOnce({
      messages: [
        { ts: "100.200", blocks: approvalButtonBlocks("req-123", "plugin", "allow-once") },
      ],
      hasMore: false,
    });
    const { ctx, getHandler } = createContext({
      installationIdentity: { kind: "workspace", teamId: "T11111111" },
      cfg: {
        approvals: { plugin: { slack: { approvers: ["team:T11111111:user:U123OWNER"] } } },
        channels: { slack: { allowFrom: ["U999LEGACY"] } },
      },
    });
    Object.assign(ctx, { teamId: "T11111111" });
    registerSlackInteractionEvents({ ctx: ctx as never });

    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
      body: {
        user: { id: "U123OWNER" },
        team: { id: "T11111111" },
        channel: { id: "C11111111" },
        container: { channel_id: "C11111111", message_ts: "100.200" },
        message: { ts: "100.200", text: "Plugin approval required", blocks: [] },
      },
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "plugin_actions",
        value:
          'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"plugin","decision":"allow-once"}',
        text: { type: "plain_text", text: "Allow once" },
      },
    });

    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "req-123",
        approvalKind: "plugin",
        senderId: "team:T11111111:user:U123OWNER",
      }),
    );
  });
});
