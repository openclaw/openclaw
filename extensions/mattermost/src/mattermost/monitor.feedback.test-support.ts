import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";

/** Ack/status reactions and audio preflight admission against the shared inbound harness. */
export function registerMattermostFeedbackTests(harness: {
  testConfig: OpenClawConfig;
  createRuntimeCore: (
    config: OpenClawConfig,
    route?: undefined,
    options?: { mentionRegexes?: RegExp[] },
  ) => { config: { current: () => OpenClawConfig } };
  receivePost: (
    post: { id: string; message: string; fileIds?: string[]; channelType?: string },
    config?: OpenClawConfig,
  ) => Promise<{ WasMentioned?: boolean } | undefined>;
  mockState: {
    abortController: AbortController | undefined;
    createMattermostClient: Mock;
    dispatchInboundMessage: Mock;
    resolveChannelInfo: Mock;
    resolveMattermostMedia: Mock;
    resolvePreflightAudioTranscript: Mock;
  };
}) {
  const { testConfig, createRuntimeCore, receivePost, mockState } = harness;

  const TERMINAL_OUTCOME = Symbol.for("openclaw.agentRunTerminalOutcome");
  it.each([
    // Acknowledgement presentation keeps the single ack emoji through thinking and tool
    // phases; only a failed run (reported solely by the terminal outcome marker on the
    // dispatch result) replaces it with the error reaction before the best-effort restore.
    { outcome: "completed", result: undefined, replaced: false },
    { outcome: "failed", result: { [TERMINAL_OUTCOME]: "failed" }, replaced: true },
  ])(
    "acks the post and cycles status reactions through a $outcome run",
    async ({ result, replaced }) => {
      const request = vi.fn<
        (path: string, init?: { method?: string; body?: string }) => Promise<unknown>
      >(async () => ({}));
      mockState.createMattermostClient.mockReturnValue({ request });
      const config = { ...testConfig, messages: { ackReactionScope: "all" as const } };
      createRuntimeCore(config);
      mockState.dispatchInboundMessage.mockImplementation(async ({ replyOptions: reply }) => {
        reply?.onAssistantMessageStart?.();
        await reply?.onToolStart?.({ toolCallId: "exec-1", name: "exec", phase: "start" });
        mockState.abortController?.abort();
        return result;
      });
      await receivePost({ id: "post-ack", message: "hello" }, config);
      const reactions = request.mock.calls.map(
        ([requestPath, init]) => `${init?.method ?? "GET"} ${requestPath} ${init?.body ?? ""}`,
      );
      const ack = 'POST /reactions {"user_id":"bot-user","post_id":"post-ack","emoji_name":"eyes"}';
      expect(replaced ? reactions.slice(0, 3) : reactions).toEqual(
        replaced
          ? [
              ack,
              'POST /reactions {"user_id":"bot-user","post_id":"post-ack","emoji_name":"x"}',
              "DELETE /users/bot-user/posts/post-ack/reactions/eyes ",
            ]
          : [ack],
      );
    },
  );

  it.each([
    // The resolved room kind reaches preflight so audio scope rules see private
    // and group rooms as `group`, never as a public channel.
    { transcript: "hey octo, deploy please", dispatched: true, channelType: "O", kind: "channel" },
    { transcript: undefined, dispatched: false, channelType: "P", kind: "group" },
  ])(
    "admits a media-only voice post only by spoken mention (transcript=$transcript, $channelType room)",
    async ({ transcript, dispatched, channelType, kind }) => {
      const config = {
        channels: {
          mattermost: { ...testConfig.channels?.mattermost, chatmode: "oncall" as const },
        },
      };
      const runtimeCore = createRuntimeCore(config, undefined, { mentionRegexes: [/\bocto\b/i] });
      // A scope rule added after the monitor started must reach the preflight: the
      // handler reads the live configuration, not its startup snapshot.
      const liveScope = {
        default: "allow" as const,
        rules: [{ action: "deny" as const, match: { chatType: "group" as const } }],
      };
      runtimeCore.config.current = () => ({
        ...config,
        tools: { media: { audio: { scope: liveScope } } },
      });
      const media = [{ path: "/tmp/voice.ogg", contentType: "audio/ogg", kind: "audio" }];
      mockState.resolveChannelInfo.mockResolvedValue(null);
      mockState.resolveMattermostMedia.mockResolvedValue(media);
      mockState.resolvePreflightAudioTranscript.mockResolvedValue(transcript);
      const ctx = await receivePost(
        { id: "post-voice", message: "", fileIds: ["voice-1"], channelType },
        config,
      );
      expect(mockState.resolvePreflightAudioTranscript).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          media,
          accountId: "default",
          originatingTo: "channel:chan-1",
          chatType: kind,
          cfg: expect.objectContaining({ tools: { media: { audio: { scope: liveScope } } } }),
        }),
      );
      expect(mockState.resolveMattermostMedia).toHaveBeenCalledTimes(1);
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      if (dispatched) {
        expect(ctx?.WasMentioned).toBe(true);
      }
    },
  );
}
