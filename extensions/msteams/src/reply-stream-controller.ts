import {
  createChannelProgressDraftGate,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  resolveChannelPreviewStreamMode,
  resolveChannelProgressDraftLabel,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingPreviewToolProgress,
} from "openclaw/plugin-sdk/channel-streaming";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type { MSTeamsConfig, ReplyPayload } from "../runtime-api.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

type Maybe<T> = T | undefined;

/**
 * Resolve the informative status text shown above the streaming card while the
 * agent is working. Pulls custom labels from `msteams.streaming.progressDraft`
 * config when set, falls back to the plugin-sdk's default rotation otherwise.
 */
export function pickInformativeStatusText(
  params: { config?: MSTeamsConfig; seed?: string; random?: () => number } | (() => number) = {},
): string | undefined {
  const options = typeof params === "function" ? { random: params } : params;
  return resolveChannelProgressDraftLabel({
    entry: options.config,
    seed: options.seed,
    random: options.random,
  });
}

// The SDK throws StreamCancelledError synchronously from stream.emit/update
// when the user pressed Stop in Teams (Teams replies 403 to the next chunk
// update and the SDK flips _canceled). Match by `name` rather than importing
// the class — tsgo can't resolve the re-export chain through
// @microsoft/teams.apps/dist/types/streamer, and the SDK's own code at
// utils/promises/retry.js falls back to this same name check.
function isStreamCancelledError(err: unknown): boolean {
  return err instanceof Error && err.name === "StreamCancelledError";
}

/**
 * Bridges openclaw's reply pipeline callbacks to the SDK's `ctx.stream`.
 * Streaming is enabled for personal (DM) conversations only; group/channel
 * messages fall through to block delivery.
 *
 * Streaming modes (resolved from `cfg.channels.msteams.streaming.preview`):
 * - "partial" (default): per-token streaming via `stream.emit(text)`. Each
 *   chunk goes onto the live preview card in Teams.
 * - "progress": no per-token streaming; the preview card carries an
 *   informative status that updates as tools run (e.g. "Looking up the
 *   schema..." → "Generating SQL..."). When tool-progress streaming is also
 *   enabled, raw tool names appear as bullets above the label.
 * - "block": disable native streaming entirely; the reply lands as a regular
 *   block message. We bypass the controller in that case.
 */
export function createTeamsReplyStreamController(params: {
  conversationType?: string;
  context: MSTeamsTurnContext;
  feedbackLoopEnabled: boolean;
  log?: MSTeamsMonitorLogger;
  msteamsConfig?: MSTeamsConfig;
  /**
   * Seed for the random label rotation so the same conversation gets the same
   * "Thinking..." flavor across reconnects. Typically `${accountId}:${convId}`.
   */
  progressSeed?: string;
  random?: () => number;
}) {
  const isPersonal = normalizeOptionalLowercaseString(params.conversationType) === "personal";
  const streamMode = resolveChannelPreviewStreamMode(params.msteamsConfig, "partial");
  const shouldUseNativeStream =
    isPersonal && (streamMode === "partial" || streamMode === "progress");
  const shouldStreamPreviewToolProgress =
    streamMode === "progress" && resolveChannelStreamingPreviewToolProgress(params.msteamsConfig);

  const stream = shouldUseNativeStream ? params.context.stream : undefined;

  let tokensEmitted = false;
  let started = false;
  let canceledLocally = false;
  let lastInformativeText = "";
  let progressLines: string[] = [];

  const wasCanceled = () => canceledLocally || Boolean(stream?.canceled);

  /**
   * Render the current informative status line into the streaming card. Pulls
   * the rotating "Thinking..." label from msteams config (or the plugin-sdk
   * default) and prepends collected tool-progress lines when configured.
   */
  const renderInformativeUpdate = (): void => {
    if (!stream || wasCanceled()) {
      return;
    }
    const informativeText = formatChannelProgressDraftText({
      entry: params.msteamsConfig,
      lines: shouldStreamPreviewToolProgress ? progressLines : [],
      seed: params.progressSeed,
      bullet: "-",
    });
    if (!informativeText || informativeText === lastInformativeText) {
      return;
    }
    lastInformativeText = informativeText;
    try {
      stream.update(informativeText);
    } catch (err) {
      if (isStreamCancelledError(err)) {
        canceledLocally = true;
        return;
      }
      params.log?.debug?.(
        `stream informative update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Gate informative updates so they only start firing once meaningful work
  // has begun (avoids flickering "Thinking..." before the first real tool
  // call). The gate is shape-agnostic — it just calls `onStart` once when the
  // first noteWork() arrives.
  const progressDraftGate = createChannelProgressDraftGate({
    onStart: renderInformativeUpdate,
  });

  return {
    async onReplyStart(): Promise<void> {
      if (!stream || started || wasCanceled()) {
        return;
      }
      started = true;
      // Render the initial informative line. In progress mode, this is the
      // configured rotating label (no tool lines yet). In partial mode, it
      // shows briefly until token streaming takes over.
      renderInformativeUpdate();
    },

    onPartialReply(payload: { text?: string }): void {
      // Partial-token streaming only fires in "partial" mode. In "progress"
      // mode, openclaw's pipeline doesn't deliver tokens — the model output
      // arrives as a single payload at preparePayload time.
      if (!stream || !payload.text || wasCanceled() || streamMode !== "partial") {
        return;
      }
      try {
        stream.emit(payload.text);
        tokensEmitted = true;
      } catch (err) {
        if (isStreamCancelledError(err)) {
          canceledLocally = true;
          return;
        }
        throw err;
      }
    },

    /**
     * Note that the agent is working — bumps the progress-draft gate so the
     * informative status starts (or refreshes) on the next render. Called
     * from the reply-dispatcher's typing callbacks.
     */
    async noteProgressWork(options?: { toolName?: string }): Promise<void> {
      if (!stream || streamMode !== "progress") {
        return;
      }
      // Filter out non-work tool names (e.g. internal scheduling helpers) so
      // the user only sees lines for tools that actually represent work.
      if (
        options?.toolName !== undefined &&
        !isChannelProgressDraftWorkToolName(options.toolName)
      ) {
        return;
      }
      const hadStarted = progressDraftGate.hasStarted;
      await progressDraftGate.noteWork();
      // If the gate was already started, the call above is a no-op — refresh
      // the informative line manually so the latest progress lines render.
      if (hadStarted && progressDraftGate.hasStarted) {
        renderInformativeUpdate();
      }
    },

    /**
     * Append a tool-progress line (e.g. a tool name being invoked) into the
     * preview card's informative status. Only takes effect in "progress" mode
     * with `streaming.previewToolProgress` enabled in config.
     */
    async pushProgressLine(line?: string, options?: { toolName?: string }): Promise<void> {
      if (!stream || streamMode !== "progress") {
        return;
      }
      if (
        options?.toolName !== undefined &&
        !isChannelProgressDraftWorkToolName(options.toolName)
      ) {
        return;
      }
      if (shouldStreamPreviewToolProgress) {
        const normalized = line?.replace(/\s+/g, " ").trim();
        if (normalized) {
          const previous = progressLines.at(-1);
          if (previous !== normalized) {
            progressLines = [...progressLines, normalized].slice(
              -resolveChannelProgressDraftMaxLines(params.msteamsConfig),
            );
          }
        }
      }
      const hadStarted = progressDraftGate.hasStarted;
      await progressDraftGate.noteWork();
      if (hadStarted && progressDraftGate.hasStarted) {
        renderInformativeUpdate();
      }
    },

    preparePayload(payload: ReplyPayload): Maybe<ReplyPayload> {
      if (!stream) {
        return payload;
      }
      // User pressed Stop (or Teams ended the stream) — the streamed prefix
      // is already visible to the user. Dropping the payload here prevents a
      // second block message from re-delivering the rest, which would override
      // the explicit cancel intent.
      if (wasCanceled()) {
        return undefined;
      }
      // Partial mode with tokens already streamed: stream carries the text;
      // strip text from the payload (keep media if any) so block delivery
      // doesn't duplicate.
      if (tokensEmitted) {
        const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
        return hasMedia ? { ...payload, text: undefined } : undefined;
      }
      // Progress mode (or partial mode that received no tokens — e.g. a
      // tool-only response): emit the final text into the stream so the
      // preview card transitions in place to the final reply. The SDK's
      // HttpStream accumulates the text and the next `finalize()` close()
      // flushes it as the closing activity.
      if (streamMode === "progress" && payload.text) {
        try {
          stream.emit(payload.text);
          tokensEmitted = true;
          const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
          return hasMedia ? { ...payload, text: undefined } : undefined;
        } catch (err) {
          if (isStreamCancelledError(err)) {
            canceledLocally = true;
            return undefined;
          }
          // Non-cancel emit failure: fall through to block delivery as a
          // safety net so the user still sees the final reply.
          params.log?.debug?.(
            `progress-mode finalize failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return payload;
    },

    async finalize(): Promise<void> {
      if (!stream || !tokensEmitted || wasCanceled()) {
        return;
      }
      // Emit a final MessageActivity carrying the AI-generated marker and (if
      // enabled) the feedback channelData. The SDK's HttpStream merges this
      // into the closing activity it sends to Teams, so streamed replies still
      // get the AI-generated label and thumbs up/down.
      const finalEntities: Array<Record<string, unknown>> = [
        {
          type: "https://schema.org/Message",
          "@type": "Message",
          "@context": "https://schema.org",
          "@id": "",
          additionalType: ["AIGeneratedContent"],
        },
      ];
      const finalChannelData: Record<string, unknown> = params.feedbackLoopEnabled
        ? { feedbackLoopEnabled: true }
        : {};
      try {
        stream.emit({
          type: "message",
          entities: finalEntities,
          channelData: finalChannelData,
        });
        await stream.close();
      } catch (err) {
        if (isStreamCancelledError(err)) {
          canceledLocally = true;
          return;
        }
        throw err;
      }
    },

    hasStream(): boolean {
      return Boolean(stream);
    },

    isStreamActive(): boolean {
      return Boolean(stream) && tokensEmitted && !wasCanceled();
    },

    wasCanceled,
  };
}
