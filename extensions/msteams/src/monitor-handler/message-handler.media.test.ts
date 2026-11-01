import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig } from "../../runtime-api.js";
import { resolveMSTeamsRequestTimeoutMs } from "../request-timeout.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
type GetTeamDetails = NonNullable<MSTeamsTurnContext["getTeamDetails"]>;
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";

const { media, graphMedia, botFrameworkMedia } = vi.hoisted(() => ({
  media: vi.fn<typeof import("../attachments/download.js").downloadMSTeamsAttachments>(),
  graphMedia: vi.fn<typeof import("../attachments/graph.js").downloadMSTeamsGraphMedia>(),
  botFrameworkMedia:
    vi.fn<
      typeof import("../attachments/bot-framework.js").downloadMSTeamsBotFrameworkAttachments
    >(),
}));
vi.mock("../attachments/download.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../attachments/download.js")>()),
  downloadMSTeamsAttachments: media,
}));
vi.mock("../attachments/graph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../attachments/graph.js")>()),
  downloadMSTeamsGraphMedia: graphMedia,
}));
vi.mock("../attachments/bot-framework.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../attachments/bot-framework.js")>()),
  downloadMSTeamsBotFrameworkAttachments: botFrameworkMedia,
}));
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  createMessageHandlerDeps,
  createTurnContext,
} from "./message-handler.test-support.js";

const dispatch = getRuntimeApiMockState().dispatchReplyWithBufferedBlockDispatcher;
type Activity = Partial<MSTeamsTurnContext["activity"]>;
const html = (content: string) => [{ contentType: "text/html", content }];
const dmConfig: MSTeamsConfig = { dmPolicy: "open", allowFrom: ["*"] };
const dmConversation = { id: "a:bot-framework-dm", conversationType: "personal" };
const pdf = { contentType: "application/pdf", kind: "document" as const };
const document = (path: string) => ({ path, ...pdf });
const teamData = (id: string) => ({ team: { id }, channel: { id: "19:channel@thread.tacv2" } });
function setup(
  config: MSTeamsConfig = {},
  getTeamDetails: GetTeamDetails = vi.fn(async () => ({ aadGroupId: "team-aad-group" })),
) {
  const msteams: MSTeamsConfig = {
    groupPolicy: "open",
    requireMention: false,
    graphMediaFallback: true,
    ...config,
  };
  const fixture = createMessageHandlerDeps({ channels: { msteams } });
  const handler = createMSTeamsMessageHandler(fixture.deps);
  const handle = (overrides: Activity = {}) => {
    const activity = buildChannelActivity({
      text: "<at>Bot</at>",
      attachments: html("<div><at>Bot</at></div>"),
      channelData: {
        team: { id: "19:team@thread.skype", aadGroupId: "team-aad" },
        channel: { id: "19:channel@thread.tacv2" },
      },
      ...overrides,
    });
    return handler({ ...createTurnContext(activity), getTeamDetails });
  };
  return { ...fixture, getTeamDetails, handle };
}
function context() {
  expect(dispatch).toHaveBeenCalledTimes(1);
  return dispatch.mock.calls[0]![0].ctx;
}

describe("Teams inbound media recovery", () => {
  beforeEach(() => {
    media.mockReset().mockResolvedValue([]);
    graphMedia.mockReset().mockResolvedValue({ media: [] });
    botFrameworkMedia.mockReset().mockResolvedValue({ media: [] });
    dispatch.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());
  afterEach(() => vi.useRealTimers());
  it("dispatches recovered tagless files without logging instruction text", async () => {
    graphMedia.mockResolvedValue({ media: [document("/tmp/from-graph.pdf")] });
    const { handle, deps } = setup();
    const privateText = "Private launch note: describe the attached image file";
    vi.spyOn(getMSTeamsRuntime().logging, "shouldLogVerbose").mockReturnValue(true);
    await handle({
      text: `<at>Bot</at> ${privateText}`,
      channelData: teamData("19:raw-team@thread.skype"),
    });
    expect(graphMedia.mock.calls[0]?.[0].messageUrl).toBe(
      "https://graph.microsoft.com/v1.0/teams/team-aad-group/channels/19%3Achannel%40thread.tacv2/messages/msg-1",
    );
    expect(context()).toMatchObject({
      BodyForAgent: privateText,
      NativeChannelId: "team-aad-group/19:channel@thread.tacv2",
      media: [expect.objectContaining(document("/tmp/from-graph.pdf"))],
    });
    expect(JSON.stringify(context())).not.toContain("19:raw-team@thread.skype/");
    const loggers = [deps.log.info, deps.log.debug!, deps.log.error, deps.runtime.error];
    expect(JSON.stringify(loggers.map((logger) => vi.mocked(logger).mock.calls))).not.toContain(
      "Private launch note",
    );
  });
  it("recovers explicit personal attachments without opting into Graph fallback or rewriting the Bot Framework ID", async () => {
    botFrameworkMedia.mockResolvedValue({ media: [document("/tmp/explicit.pdf")] });
    const { handle } = setup({ ...dmConfig, graphMediaFallback: undefined, replyStyle: "thread" });
    await handle({
      conversation: dmConversation,
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      channelData: {},
      replyToId: "dm-parent",
      attachments: html('<div><attachment id="attachment-1"></attachment></div>'),
    });
    expect(botFrameworkMedia).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        attachmentIds: ["attachment-1"],
      }),
    );
    expect(graphMedia).not.toHaveBeenCalled();
    expect(context()).toMatchObject({
      BodyForAgent: "",
      To: "user:user-aad",
      OriginatingTo: "conversation:a:bot-framework-dm",
      media: [expect.objectContaining(document("/tmp/explicit.pdf"))],
    });
    expect(context().MessageThreadId).toBeUndefined();
  });
  it.each([false, true])("emits no ghost event (mention required: %s)", async (requireMention) => {
    const { handle, enqueueSystemEvent } = setup({ requireMention });
    await handle(
      requireMention ? { text: "", entities: [], attachments: html("<div></div>") } : {},
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });
  it("preserves ordinary reply text when the Teams API cannot resolve a Graph team ID", async () => {
    const getTeamDetails = vi.fn(async () => {
      throw new Error("Teams API unavailable");
    });
    const { handle } = setup({}, getTeamDetails);
    await handle({
      text: "<at>Bot</at> keep this text",
      replyToId: "unresolved-parent",
      channelData: teamData("19:team-unresolved@thread.skype"),
    });
    expect(graphMedia).not.toHaveBeenCalled();
    expect(context()).toMatchObject({ BodyForAgent: "keep this text", NativeChannelId: undefined });
  });
  it.each([true, false])(
    "preserves slow download and enrichment budgets (personal: %s)",
    async (personal) => {
      const team = "19:slow-media-team@thread.skype";
      const input: Activity = personal
        ? {
            conversation: dmConversation,
            channelData: {},
            text: "what is this?",
            entities: [],
            attachments: [{ contentType: "image/png" }],
          }
        : {
            text: "<at>Bot</at> see image",
            channelData: teamData(team),
          };
      const transferMs = 45_000;
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
      const { handle } = setup(personal ? dmConfig : {});
      const run = handle(input);
      await vi.advanceTimersByTimeAsync(transferMs);
      await run;
      expect(context()).toMatchObject({
        ...(personal
          ? { BodyForAgent: "what is this?" }
          : { NativeChannelId: "team-aad-group/19:channel@thread.tacv2" }),
        media: [expect.objectContaining({ path: "/tmp/pasted.png", kind: "image" })],
      });
    },
  );
});
