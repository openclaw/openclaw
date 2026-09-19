import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import { setSlackRuntime } from "./runtime.js";

const { conversationsInfoMock, createSlackLookupClientMock } = vi.hoisted(() => ({
  conversationsInfoMock: vi.fn(),
  createSlackLookupClientMock: vi.fn(),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  const createClient = () => ({
    conversations: { info: conversationsInfoMock },
  });
  return {
    ...actual,
    createSlackLookupClient: createSlackLookupClientMock.mockImplementation(createClient),
  };
});

beforeEach(() => {
  conversationsInfoMock.mockReset();
  createSlackLookupClientMock.mockReset();
  createSlackLookupClientMock.mockImplementation(() => ({
    conversations: { info: conversationsInfoMock },
  }));
  setSlackRuntime({ channel: { slack: {} } } as never);
});

describe("Slack outbound route cancellation", () => {
  it("passes cancellation through G-prefixed conversation routing", async () => {
    const resolveRoute = slackPlugin.messaging?.resolveOutboundSessionRoute;
    if (!resolveRoute) {
      throw new Error("slack messaging.resolveOutboundSessionRoute unavailable");
    }
    conversationsInfoMock.mockResolvedValueOnce({
      channel: { id: "G123456789", is_im: true, user: "U123456789" },
    });
    const controller = new AbortController();

    const route = await resolveRoute({
      cfg: { channels: { slack: { botToken: "lookup-fixture" } } } as OpenClawConfig,
      agentId: "main",
      target: "G123456789",
      signal: controller.signal,
    });

    expect(createSlackLookupClientMock).toHaveBeenCalledWith(
      "lookup-fixture",
      {
        teamId: undefined,
        signal: controller.signal,
      },
      undefined,
    );
    expect(route).toMatchObject({
      to: "user:G123456789",
      recipientSessionExact: true,
    });
  });
});
