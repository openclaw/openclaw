import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig } from "../../runtime-api.js";
import { resolveMSTeamsRequestTimeoutMs } from "../request-timeout.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import type { resolveMSTeamsInboundMedia } from "./inbound-media.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";

const media = vi.hoisted(() => vi.fn<typeof resolveMSTeamsInboundMedia>());
vi.mock("./inbound-media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound-media.js")>()),
  resolveMSTeamsInboundMedia: media,
}));
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { buildChannelActivity, createMessageHandlerDeps } from "./message-handler.test-support.js";

const dispatch = getRuntimeApiMockState().dispatchReplyWithBufferedBlockDispatcher;
const tagless = { contentType: "text/html", content: "<div><at>Bot</at></div>" };
function setup(
  config: MSTeamsConfig = {},
  getTeamDetails: NonNullable<MSTeamsTurnContext["getTeamDetails"]> = vi.fn<
    NonNullable<MSTeamsTurnContext["getTeamDetails"]>
  >(async () => ({
    aadGroupId: "team-aad-group",
  })),
) {
  const fixture = createMessageHandlerDeps({
    channels: {
      msteams: {
        groupPolicy: "open",
        requireMention: false,
        graphMediaFallback: true,
        ...config,
      },
    },
  });
  const handler = createMSTeamsMessageHandler(fixture.deps);
  return {
    ...fixture,
    getTeamDetails,
    handle: (overrides: Partial<MSTeamsTurnContext["activity"]> = {}) =>
      handler({
        activity: buildChannelActivity({
          text: "<at>Bot</at>",
          attachments: [tagless],
          channelData: {
            team: { id: "19:team@thread.skype", aadGroupId: "team-aad" },
            channel: { id: "19:channel@thread.tacv2" },
          },
          ...overrides,
        }),
        getTeamDetails,
        sendActivity: vi.fn(async () => undefined),
        sendActivities: vi.fn(async () => []),
        updateActivity: vi.fn(async () => undefined),
        deleteActivity: vi.fn(async () => undefined),
      }),
  };
}
function context() {
  expect(dispatch).toHaveBeenCalledTimes(1);
  return dispatch.mock.calls[0]![0].ctx;
}

describe("Teams inbound media recovery", () => {
  beforeEach(() => {
    media.mockReset();
    dispatch.mockClear();
  });
  it("dispatches recovered tagless files without logging instruction text", async () => {
    media.mockResolvedValue([
      { path: "/tmp/from-graph.pdf", contentType: "application/pdf", kind: "document" },
    ]);
    const { handle, getTeamDetails, deps } = setup();
    const privateText = "Private launch note: describe the attached image file";
    const rawText = `<at>Bot</at> ${privateText}`;
    const verbose = vi.spyOn(getMSTeamsRuntime().logging, "shouldLogVerbose").mockReturnValue(true);
    try {
      await handle({
        text: rawText,
        channelData: {
          team: { id: "19:raw-team@thread.skype" },
          channel: { id: "19:channel@thread.tacv2" },
        },
      });
    } finally {
      verbose.mockRestore();
    }
    expect(media).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        graphMediaFallback: true,
        teamAadGroupId: undefined,
        resolveTeamAadGroupId: expect.any(Function),
      }),
    );
    expect(getTeamDetails).toHaveBeenCalledExactlyOnceWith("19:raw-team@thread.skype");
    expect(context()).toMatchObject({
      BodyForAgent: privateText,
      NativeChannelId: "team-aad-group/19:channel@thread.tacv2",
      media: [
        expect.objectContaining({
          path: "/tmp/from-graph.pdf",
          contentType: "application/pdf",
          kind: "document",
        }),
      ],
    });
    expect(JSON.stringify(context())).not.toContain("19:raw-team@thread.skype/");
    const logs = JSON.stringify([
      vi.mocked(deps.log.info).mock.calls,
      vi.mocked(deps.log.debug!).mock.calls,
      vi.mocked(deps.log.error).mock.calls,
      vi.mocked(deps.runtime.error).mock.calls,
    ]);
    expect(logs).not.toContain("Private launch note");
  });
  it("recovers explicit personal attachments without opting into Graph fallback or rewriting the Bot Framework ID", async () => {
    media.mockResolvedValue([
      { path: "/tmp/explicit.pdf", contentType: "application/pdf", kind: "document" },
    ]);
    const { handle } = setup({
      dmPolicy: "open",
      allowFrom: ["*"],
      graphMediaFallback: undefined,
      replyStyle: "thread",
    });
    await handle({
      conversation: { id: "a:bot-framework-dm", conversationType: "personal" },
      channelData: {},
      replyToId: "dm-parent",
      attachments: [
        {
          contentType: "text/html",
          content: '<div><attachment id="attachment-1"></attachment></div>',
        },
      ],
      entities: [],
    });
    expect(media).toHaveBeenCalledWith(
      expect.objectContaining({
        graphMediaFallback: undefined,
        conversationId: "a:bot-framework-dm",
      }),
    );
    expect(media.mock.calls[0]![0]).not.toHaveProperty("graphChatId");
    expect(context()).toMatchObject({
      BodyForAgent: "",
      To: "user:user-aad",
      OriginatingTo: "conversation:a:bot-framework-dm",
      media: [
        expect.objectContaining({
          path: "/tmp/explicit.pdf",
          contentType: "application/pdf",
          kind: "document",
        }),
      ],
    });
    expect(context().MessageThreadId).toBeUndefined();
  });
  it("does not emit a ghost event when Graph recovery is empty", async () => {
    media.mockResolvedValue([]);
    const { handle, getTeamDetails, enqueueSystemEvent } = setup();
    await handle();
    expect(media).toHaveBeenCalledTimes(1);
    expect(getTeamDetails).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });
  it("reports a Graph-discovered unavailable attachment", async () => {
    media.mockResolvedValue([{ kind: "document" }]);
    await setup().handle();
    expect(context()).toMatchObject({
      BodyForAgent: "[msteams attachment unavailable]",
      media: [expect.objectContaining({ kind: "document" })],
    });
  });
  it("preserves ordinary reply text when the Teams API cannot resolve a Graph team ID", async () => {
    media.mockResolvedValue([]);
    const getTeamDetails = vi.fn(async () => {
      throw new Error("Teams API unavailable");
    });
    const { handle } = setup({}, getTeamDetails);
    await handle({
      text: "<at>Bot</at> keep this text",
      replyToId: "unresolved-parent",
      channelData: {
        team: { id: "19:team-unresolved@thread.skype" },
        channel: { id: "19:channel@thread.tacv2" },
      },
    });
    expect(getTeamDetails).toHaveBeenCalledWith("19:team-unresolved@thread.skype");
    expect(media).toHaveBeenCalledWith(expect.objectContaining({ teamAadGroupId: undefined }));
    expect(context()).toMatchObject({ BodyForAgent: "keep this text", NativeChannelId: undefined });
  });
  describe("slow attachment transfers", () => {
    const transferMs = 45_000;
    beforeEach(() => {
      vi.useFakeTimers();
      // Mirror a guarded fetch: the per-request timeout comes from the deadline it was handed.
      media.mockImplementation(async ({ deadline }) => {
        if (resolveMSTeamsRequestTimeoutMs(deadline) < transferMs) {
          throw new Error("request timed out");
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, transferMs);
        });
        return [{ path: "/tmp/pasted.png", contentType: "image/png", kind: "image" }];
      });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("delivers a pasted DM image whose Bot Framework download outlasts enrichment budgets", async () => {
      const { handle } = setup({ dmPolicy: "open", allowFrom: ["*"] });
      const run = handle({
        conversation: { id: "a:bot-framework-dm", conversationType: "personal" },
        channelData: {},
        text: "what is this?",
        attachments: [
          {
            contentType: "image/*",
            contentUrl: "https://smba.trafficmanager.net/au/tenant/v3/attachments/a/views/original",
          },
        ],
        entities: [],
      });
      await vi.advanceTimersByTimeAsync(transferMs);
      await run;
      expect(context()).toMatchObject({
        BodyForAgent: "what is this?",
        media: [expect.objectContaining({ path: "/tmp/pasted.png", kind: "image" })],
      });
    });

    it("keeps the full enrichment budget for team identity after slow media", async () => {
      const { handle, getTeamDetails } = setup();
      const run = handle({
        text: "<at>Bot</at> see image",
        channelData: {
          team: { id: "19:slow-media-team@thread.skype" },
          channel: { id: "19:channel@thread.tacv2" },
        },
      });
      await vi.advanceTimersByTimeAsync(transferMs);
      await run;
      expect(getTeamDetails).toHaveBeenCalledExactlyOnceWith("19:slow-media-team@thread.skype");
      expect(context()).toMatchObject({
        NativeChannelId: "team-aad-group/19:channel@thread.tacv2",
        media: [expect.objectContaining({ path: "/tmp/pasted.png" })],
      });
    });
  });
  it("drops unmentioned empty HTML before media recovery", async () => {
    const { handle, getTeamDetails, enqueueSystemEvent } = setup({ requireMention: true });
    await handle({
      text: "",
      entities: [],
      attachments: [{ contentType: "text/html", content: "<div></div>" }],
    });
    expect(getTeamDetails).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
