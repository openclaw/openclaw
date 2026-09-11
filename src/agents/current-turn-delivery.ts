import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Type, type Static } from "typebox";
import {
  resolveMessageActionTurnCapability,
  selectMessageActionRequesterIdentity,
} from "../gateway/message-action-turn-capability.js";
import { formatErrorMessage } from "../infra/errors.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { resolveAgentScopedOutboundMediaAccess } from "../media/read-capability.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { OpenClawPluginToolContext } from "../plugins/tool-types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import {
  beginCurrentTurnReplyCompletion,
  createCurrentTurnReplyCompletionOwner,
} from "./current-turn-reply-completion.js";
import { stringEnum } from "./schema/typebox.js";
import {
  asToolParamsRecord,
  jsonResult,
  readToolStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./tools/common.js";

const currentTurnDeliveryOutputSchema = Type.Object(
  {
    status: stringEnum(["sent", "suppressed", "not_sent", "partial_failed", "failed"] as const),
    messageId: Type.Optional(Type.String()),
    suppressionReason: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    sentBeforeError: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

type CurrentTurnDeliveryResult = Static<typeof currentTurnDeliveryOutputSchema>;

export type CurrentTurnDelivery = {
  send(
    input: { text?: string; mediaUrl?: string },
    bestEffort?: boolean,
    signal?: AbortSignal,
    onDispatch?: () => void,
    onNotDispatched?: () => void,
  ): Promise<CurrentTurnDeliveryResult>;
};

/** Private construction slot for the exact host-created delivery tool instance. */
export type CurrentTurnDeliveryToolRef = {
  value?: AnyAgentTool;
};

/** Exact host-owned lifetime required by current-turn delivery. */
export type CurrentTurnDeliveryAuthority = {
  abortSignal: AbortSignal;
  assertActive: () => void;
};

/** Private writer-bound construction for the one-shot terminal reply tool. */
type CurrentTurnTerminalReplyConstruction = {
  authority: CurrentTurnDeliveryAuthority;
  toolRef: CurrentTurnDeliveryToolRef;
  completionOwner?: object;
};

/** Private construction authorities for ordinary and terminal delivery. */
export type CurrentTurnDeliveryConstruction = {
  deliveryAuthority: CurrentTurnDeliveryAuthority;
  terminalReply?: CurrentTurnTerminalReplyConstruction;
};

export function rebindCurrentTurnDeliveryToolRef(
  ref: CurrentTurnDeliveryToolRef | undefined,
  before: readonly AnyAgentTool[],
  after: readonly AnyAgentTool[],
): void {
  if (!ref) {
    return;
  }
  const rebound = ref.value ? after[before.indexOf(ref.value)] : undefined;
  if (rebound) {
    ref.value = rebound;
  } else {
    delete ref.value;
  }
}

const loadMessageActionRunner = createLazyRuntimeModule(
  () => import("../infra/outbound/message-action-runner.js"),
);

export function createCurrentTurnDelivery(params: {
  authority?: CurrentTurnDeliveryAuthority;
  context: OpenClawPluginToolContext;
  agentSessionKey?: string;
  runId?: string;
  token?: string;
  revokedErrorMessage?: string;
}): CurrentTurnDelivery | undefined {
  const authority = params.authority;
  const route = normalizeDeliveryContext(params.context.deliveryContext);
  const { agentId, sessionKey, sessionId } = params.context;
  const policySessionKey = params.agentSessionKey ?? sessionKey;
  const registry = getActivePluginRegistry();
  const registryVersion = getActivePluginRegistryVersion();
  if (!route?.channel || !route.to || !registry || !params.context.runtimeConfig || !authority) {
    return undefined;
  }
  if (!agentId || !sessionKey || !policySessionKey || !params.runId || !params.token) {
    return undefined;
  }
  const channel = registry.channels.find((entry) => entry.plugin.id === route.channel);
  if (!channel || channel.plugin.outbound?.deliveryMode === "gateway") {
    return undefined;
  }

  // Registry reload or turn close revokes retained tool copies before provider I/O.
  const authorize = () => {
    const authorization =
      getActivePluginRegistry() === registry && getActivePluginRegistryVersion() === registryVersion
        ? resolveMessageActionTurnCapability({
            token: params.token,
            agentId,
            runId: params.runId,
            sessionKey: policySessionKey,
            sessionId,
          })
        : undefined;
    if (!authorization) {
      throw new Error(
        params.revokedErrorMessage ?? "current-turn delivery capability is no longer active",
      );
    }
    return authorization;
  };
  const initialAuthorization = authorize();
  const requesterIdentity = selectMessageActionRequesterIdentity(initialAuthorization);
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg: params.context.runtimeConfig,
    agentId,
    workspaceDir: params.context.workspaceDir,
    sessionKey,
    accountId: initialAuthorization.requesterAccountId ?? route.accountId,
    ...requesterIdentity,
  });

  return {
    async send({ text, mediaUrl }, bestEffort, invocationSignal, onDispatch, onNotDispatched) {
      // Capture source execution inside this invocation before any await. The
      // construction-time authority above cannot be borrowed from a later call.
      const abortSignal = invocationSignal
        ? AbortSignal.any([authority.abortSignal, invocationSignal])
        : authority.abortSignal;
      const assertSourceExecutionCurrent = captureAgentToolSourceExecutionGuard(abortSignal);
      const assertCurrent = () => {
        try {
          assertSourceExecutionCurrent();
          authority.assertActive();
          return authorize();
        } catch (error) {
          if (error instanceof PlatformMessageNotDispatchedError) {
            throw error;
          }
          throw new PlatformMessageNotDispatchedError(formatErrorMessage(error), {
            cause: error,
            retryable: false,
          });
        }
      };
      let handedOff = false;
      let reportedSent = false;
      try {
        assertCurrent();
        const { runMessageAction } = await loadMessageActionRunner();
        const authorization = assertCurrent();
        const cfg = params.context.getRuntimeConfig?.();
        if (!cfg) {
          throw new Error("current-turn delivery requires an active runtime config");
        }
        const result = await withPluginRuntimeRegistryScope(registry, () =>
          runMessageAction({
            cfg,
            action: "send",
            params: {
              channel: route.channel,
              target: route.to,
              ...(route.accountId ? { accountId: route.accountId } : {}),
              ...(route.threadId != null ? { threadId: route.threadId } : {}),
              ...(text !== undefined ? { message: text } : {}),
              ...(mediaUrl !== undefined ? { mediaUrl } : {}),
              ...(bestEffort !== undefined ? { bestEffort } : {}),
            },
            defaultAccountId: route.accountId,
            ...requesterIdentity,
            messageActionAuthorization: {
              requesterAccountId: authorization.requesterAccountId,
              requesterSenderId: authorization.requesterSenderId,
              toolContext: authorization.toolContext,
            },
            senderIsOwner: params.context.senderIsOwner,
            conversationReadOrigin: params.context.conversationReadOrigin,
            toolContext: authorization.toolContext,
            sessionKey,
            sessionId,
            runId: params.runId,
            agentId,
            mediaAccess,
            abortSignal,
            onDeliveryAttempt: async () => void assertCurrent(),
            onPlatformSendDispatch: async () => void assertCurrent(),
            assertDirectAdapterHandoff: () => {
              assertCurrent();
              handedOff = true;
              // The synchronous authority fence has passed. A held acknowledgement
              // must not leave cancellation free to send another reply.
              onDispatch?.();
            },
            forceCoreDelivery: true,
            skipQueue: true,
            dryRun: false,
          }),
        );
        const sendResult = result.kind === "send" ? result.sendResult : undefined;
        const messageId = sendResult?.result?.messageId;
        const status =
          sendResult?.deliveryStatus === "suppressed" &&
          sendResult.suppressionReason === "adapter_returned_no_send"
            ? "not_sent"
            : sendResult?.deliveryStatus === "failed" && sendResult.sentBeforeError === true
              ? "partial_failed"
              : (sendResult?.deliveryStatus ?? (messageId ? "sent" : "failed"));
        const projected: CurrentTurnDeliveryResult = {
          status,
          ...(messageId ? { messageId } : {}),
          ...(sendResult?.suppressionReason
            ? { suppressionReason: sendResult.suppressionReason }
            : {}),
          ...(sendResult?.error ? { error: sendResult.error } : {}),
          ...(sendResult?.sentBeforeError ? { sentBeforeError: true } : {}),
          ...(!sendResult ? { error: "current-turn delivery returned no send result" } : {}),
        };
        reportedSent = projected.status === "sent" || projected.sentBeforeError === true;
        try {
          assertCurrent();
          return projected;
        } catch (error) {
          if (!reportedSent) {
            throw error;
          }
          return {
            ...projected,
            status: "partial_failed",
            error: formatErrorMessage(error),
            sentBeforeError: true,
          };
        }
      } finally {
        // Only the producer knows no adapter was entered. Preserve thrown errors
        // verbatim, including AbortError identity, while releasing settled preparation.
        if (!handedOff && !reportedSent) {
          onNotDispatched?.();
        }
      }
    },
  };
}

export function createCurrentTurnDeliveryTool(
  delivery: CurrentTurnDelivery,
  completionOwner: object = createCurrentTurnReplyCompletionOwner(),
): AnyAgentTool {
  // One instance remains one-shot after non-dispatch; only a newly constructed
  // tool may retry with the released shared turn admission.
  let consumed = false;
  return {
    name: "send_current_reply",
    label: "Send current reply",
    description:
      "Send one reply to the host-selected conversation for this OpenClaw Code Mode turn.",
    parameters: Type.Object(
      {
        text: Type.String({ minLength: 1 }),
        mediaUrl: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    outputSchema: currentTurnDeliveryOutputSchema,
    async execute(_toolCallId, args, signal) {
      const input = asToolParamsRecord(args);
      const text = readToolStringParam(input, "text", { required: true });
      const mediaUrl = readToolStringParam(input, "mediaUrl");
      const recordCompletion = !consumed && beginCurrentTurnReplyCompletion(completionOwner);
      if (!recordCompletion) {
        throw new ToolInputError("current-turn delivery authority has already been consumed");
      }
      consumed = true;
      let dispatchStarted = false;
      let provenNotDispatched = false;
      let result: CurrentTurnDeliveryResult;
      try {
        result = await delivery.send(
          { text, mediaUrl },
          true,
          signal,
          () => {
            dispatchStarted = true;
            recordCompletion("pending");
          },
          () => {
            provenNotDispatched = true;
          },
        );
      } catch (error) {
        const sentBeforeError = asOptionalRecord(error)?.sentBeforeError === true;
        result = {
          status: sentBeforeError ? "partial_failed" : "failed",
          error: formatErrorMessage(error),
          ...(sentBeforeError ? { sentBeforeError: true } : {}),
        };
      }
      const terminal =
        result.status === "sent" ||
        (result.status === "partial_failed" && result.sentBeforeError === true);
      if (terminal) {
        // This exact instance owns the effect. Later hooks, projection rejection,
        // or cancellation cannot turn an ambiguous dispatch into another send.
        recordCompletion(result.status === "sent" ? "confirmed" : "ambiguous");
      } else if (
        provenNotDispatched ||
        result.status === "not_sent" ||
        (result.status === "suppressed" &&
          result.suppressionReason !== "adapter_returned_no_identity")
      ) {
        recordCompletion(undefined);
      } else if (dispatchStarted) {
        // An error without authoritative non-dispatch evidence cannot release
        // the one-shot effect, even when no message identity was acknowledged.
        recordCompletion("ambiguous");
      }
      const toolResult = jsonResult(result);
      return terminal ? { ...toolResult, terminate: true } : toolResult;
    },
  };
}
