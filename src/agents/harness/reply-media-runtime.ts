import { copyReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import {
  applyPreparedReplyMedia,
  createReplyMediaSourcePreparer,
} from "../../auto-reply/reply/reply-media-paths.js";
import { resolveSendableOutboundReplyParts } from "../../infra/outbound/reply-payload-parts.js";
import { createBoundedOutboundMediaReadFile } from "../../media/bounded-read-file.js";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import { toRelativeWorkspacePath } from "../path-policy.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

type Prepare = NonNullable<AgentHarnessHostCapabilities["prepareReplyMedia"]>;

export async function prepareHarnessReplyMedia(params: {
  request: Parameters<Prepare>[0];
  context: Parameters<typeof createReplyMediaSourcePreparer>[0] & {
    sourceReplyDeliveryMode?: Parameters<
      typeof buildEmbeddedRunPayloads
    >[0]["sourceReplyDeliveryMode"];
    runId?: string;
    reasoningLevel?: Parameters<typeof buildEmbeddedRunPayloads>[0]["reasoningLevel"];
  };
  signal: AbortSignal;
  assertCurrent: () => void;
}): ReturnType<Prepare> {
  const { request, context, signal, assertCurrent } = params;
  const maxBytes = resolveOutboundMediaMaxBytes({
    cfg: context.cfg,
    channel: context.messageProvider,
    accountId: context.accountId,
  });
  const prepare = createReplyMediaSourcePreparer({
    ...context,
    workspaceMediaRoot: request.workspaceRoot ?? context.workspaceDir,
    workspaceMediaAccess: {
      localRoots: [context.workspaceDir],
      workspaceDir: context.workspaceDir,
      readFile: createBoundedOutboundMediaReadFile(async (filePath, options) => {
        assertCurrent();
        const relativePath = toRelativeWorkspacePath(context.workspaceDir, filePath);
        const bytes = await request.readWorkspaceFile(relativePath, {
          maxBytes: Math.min(maxBytes, options?.maxBytes ?? maxBytes),
          signal,
        });
        assertCurrent();
        return bytes;
      }),
    },
  });
  if (request.kind === "payload") {
    const directives = parseReplyDirectives(request.payload.text ?? "");
    const payload = copyReplyPayloadMetadata(request.payload, {
      ...request.payload,
      text: directives.text,
      mediaUrls: [
        ...new Set([
          ...resolveSendableOutboundReplyParts(request.payload).mediaUrls,
          ...(directives.mediaUrls ?? []),
        ]),
      ],
      ...(directives.audioAsVoice ? { audioAsVoice: true } : {}),
      ...(directives.replyToId ? { replyToId: directives.replyToId } : {}),
      ...(directives.replyToCurrent ? { replyToCurrent: true } : {}),
    });
    const prepared = await prepare(resolveSendableOutboundReplyParts(payload).mediaUrls);
    assertCurrent();
    return { kind: "payload", payload: applyPreparedReplyMedia(payload, prepared) };
  }
  const result = request.attempt;
  const assistant = result.yieldDetected
    ? result.lastAssistant
    : result.currentAttemptCompletedAssistant;
  // Use the same answer selector as terminal delivery. Only the attachment facts
  // are retained; terminal text, routing, suppression and transcripts remain owned there.
  const payloads = buildEmbeddedRunPayloads({
    ...context,
    config: context.cfg,
    sessionKey: context.sessionKey ?? "",
    assistantTexts: result.assistantTexts,
    answerSegments: result.answerSegments,
    lastAssistant: assistant,
    currentAssistant: result.yieldDetected ? null : (assistant ?? null),
    lastToolError: result.lastToolError,
    didSendViaMessagingTool: result.didSendViaMessagingTool,
    didDeliverSourceReplyViaMessageTool: result.didDeliverSourceReplyViaMessageTool,
    messagingToolSentTargets: result.messagingToolSentTargets,
    messagingToolSourceReplyPayloads: result.messagingToolSourceReplyPayloads,
    didSendDeterministicApprovalPrompt: result.didSendDeterministicApprovalPrompt,
    heartbeatToolResponse: result.heartbeatToolResponse,
    runAborted: result.terminal.kind === "aborted",
  });
  const sources = [
    ...new Set(payloads.flatMap((payload) => resolveSendableOutboundReplyParts(payload).mediaUrls)),
  ];
  const preparedMedia = await prepare(sources);
  assertCurrent();
  return { kind: "attempt", preparedMedia };
}
