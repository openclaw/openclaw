import type {
  createChannelProgressWorkCounter,
  ChannelProgressDraftCompositorSnapshot,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveGatewayPublicOrigin } from "openclaw/plugin-sdk/config-contracts";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { buildControlUiSessionPath } from "openclaw/plugin-sdk/session-discussion";
import { buildSlackCompleteBlocksFallbackText } from "../../blocks-fallback.js";
import { createSlackDraftStream } from "../../draft-stream.js";
import { formatSlackError } from "../../errors.js";
import { normalizeSlackOutboundText } from "../../format.js";
import { SLACK_TEXT_LIMIT } from "../../limits.js";
import {
  buildSlackProgressCardBlocks,
  type SlackProgressSessionLink,
} from "../../progress-blocks.js";
import { truncateSlackText } from "../../truncate.js";
import { escapeSlackMrkdwn } from "../mrkdwn.js";
import { resolveStructuredProgressLines } from "./dispatch-progress-render.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import { finalizeSlackPreviewEdit } from "./preview-finalize.js";

type DraftProgressCardState = "working" | "success" | "error";
const MAX_VISIBLE_WORK_LINKS = 5;
type VisibleWorkSessions = Parameters<NonNullable<GetReplyOptions["onVisibleWorkSessions"]>>[0];

export function createSlackDraftProgressCardRuntime(params: {
  setup: Pick<SlackDispatchSetup, "account" | "cfg" | "ctx" | "prepared" | "slackClient">;
  draftStream: ReturnType<typeof createSlackDraftStream> | undefined;
  enabled: boolean;
  detailed: boolean;
  progressWorkCounter: ReturnType<typeof createChannelProgressWorkCounter> | undefined;
  explicitTitle: string | undefined;
  maxLineChars: number;
  getSnapshot: () => ChannelProgressDraftCompositorSnapshot;
  getThreadTs: () => string | undefined;
}) {
  const { account, cfg, ctx, prepared, slackClient } = params.setup;
  let finalStatus: Exclude<DraftProgressCardState, "working"> | undefined;
  const visibleWorkSessions = new Map<string, VisibleWorkSessions[number]>();

  const resolveSessionLinks = (): SlackProgressSessionLink[] => {
    if (visibleWorkSessions.size > 0) {
      return [...visibleWorkSessions.values()]
        .slice(0, MAX_VISIBLE_WORK_LINKS)
        .map((session, index) => {
          const label = session.label?.replace(/\s+/g, " ").trim();
          return {
            url: session.url,
            text:
              visibleWorkSessions.size === 1
                ? "Open work session"
                : truncateSlackText(label ? `Open ${label}` : `Open work session ${index + 1}`, 75),
          };
        });
    }
    // Both conditions are the operator's own statement that this session is
    // openable: `publicOrigin` is where the Gateway is externally reachable,
    // and the Control UI is what serves the session route. Installations that
    // set neither, or that replaced the Control UI, get no dead link.
    if (cfg.gateway?.controlUi?.enabled === false) {
      return [];
    }
    const publicOrigin = resolveGatewayPublicOrigin(cfg);
    if (!publicOrigin) {
      return [];
    }
    const url = new URL(publicOrigin);
    const path = buildControlUiSessionPath({
      namespace: "chat",
      sessionKey: prepared.ctxPayload.SessionKey ?? prepared.route.sessionKey,
      fallbackAgentId: prepared.route.agentId,
      mainKey: cfg.session?.mainKey,
      basePath: cfg.gateway?.controlUi?.basePath,
    });
    if (!path) {
      return [];
    }
    url.pathname = path;
    return [{ url: url.toString(), text: "Open in OpenClaw" }];
  };

  const resolvePresentation = (
    snapshot: ChannelProgressDraftCompositorSnapshot,
    state: DraftProgressCardState,
  ) => {
    const narration = [
      { text: snapshot.statusHeadline ?? "", format: snapshot.statusHeadlineFormat },
      { text: snapshot.planExplanation ?? "", format: snapshot.planExplanationFormat },
    ];
    return buildSlackProgressCardBlocks({
      state,
      detailed: params.detailed,
      title: params.explicitTitle,
      narration,
      plan: snapshot.plan,
      lines: resolveStructuredProgressLines(snapshot.lines),
      maxLineChars: params.maxLineChars,
      diffStat: snapshot.diffStat,
      toolCalls: params.progressWorkCounter?.toolCalls,
      elapsedSeconds: params.progressWorkCounter?.elapsedSeconds,
      sessionLinks: state === "working" ? [] : resolveSessionLinks(),
    });
  };

  // Blocks carry the card; its fallback text must fit the draft limit or the stream stops.
  const resolveCardText = (blocks: ReturnType<typeof resolvePresentation>) =>
    truncateSlackText(
      buildSlackCompleteBlocksFallbackText(blocks),
      Math.min(ctx.textLimit, SLACK_TEXT_LIMIT),
    );

  const finalize = async (
    status: Exclude<DraftProgressCardState, "working">,
    options: { snapshot?: ChannelProgressDraftCompositorSnapshot; postIfMissing?: boolean } = {},
  ): Promise<boolean> => {
    if (!params.draftStream || !params.enabled) {
      return false;
    }
    await params.draftStream.dropDetachedMessages();
    const terminalStatus = finalStatus === "error" || status === "error" ? "error" : "success";
    if (finalStatus === terminalStatus) {
      return true;
    }
    await params.draftStream.flush();
    const snapshot = options.snapshot ?? params.getSnapshot();
    let channelId = params.draftStream.channelId();
    let messageId = params.draftStream.messageId();
    const blocks = resolvePresentation(snapshot, terminalStatus);
    if ((!channelId || !messageId) && terminalStatus === "error" && options.postIfMissing) {
      params.draftStream.update({ text: resolveCardText(blocks), blocks });
      await params.draftStream.flush();
      channelId = params.draftStream.channelId();
      messageId = params.draftStream.messageId();
    }
    if (!channelId || !messageId) {
      return false;
    }
    // Nothing left to show (e.g. only a resolved approval): delete here so every
    // closeout path, including failures without a final reply, drops stale rows.
    if (blocks.length === 0) {
      await params.draftStream.clear();
      finalStatus = terminalStatus;
      return true;
    }
    await params.draftStream.seal();
    try {
      const finalized = await params.draftStream.finalizeMessage(messageId, async () => {
        await finalizeSlackPreviewEdit({
          client: slackClient,
          token: ctx.botToken,
          accountId: account.accountId,
          channelId,
          messageId,
          text: resolveCardText(blocks),
          blocks,
          threadTs: params.getThreadTs(),
        });
      });
      if (finalized) {
        finalStatus = terminalStatus;
      }
      return finalized;
    } catch (err) {
      logVerbose(`slack: progress card final edit failed (${formatSlackError(err)})`);
      return false;
    }
  };

  return {
    resolveSessionLinks,
    onVisibleWorkSessions: (sessions: VisibleWorkSessions) => {
      for (const session of sessions) {
        if (!visibleWorkSessions.has(session.sessionKey)) {
          visibleWorkSessions.set(session.sessionKey, session);
        }
      }
    },
    resolvePresentation,
    resolveCardText,
    finalize,
    get hasTerminalized() {
      return finalStatus !== undefined;
    },
    reset() {
      finalStatus = undefined;
      visibleWorkSessions.clear();
    },
  };
}

export function formatSlackProgressDraftLine(line: string): string {
  if (/^(?:🧠|💬)\s/u.test(line)) {
    return line;
  }

  const italicCommentary = /^_(.*)_$/su.exec(line);
  if (!italicCommentary) {
    return escapeSlackMrkdwn(line);
  }

  const content = normalizeSlackOutboundText(italicCommentary[1]!, {
    mentions: "escape",
    enclosingStyle: "italic",
  });

  return `_${content}_`;
}
