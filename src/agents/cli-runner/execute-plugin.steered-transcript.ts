import {
  MessageInjectionAcceptedUnconfirmedError,
  withMessageInjectionAdmission,
} from "../../auto-reply/reply/message-injection-authority.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { labelRuntimeContextText } from "../../llm/types.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { isMeaningfulMediaFact, readPersistedMediaFacts } from "../../media/media-facts.js";
import { hasPromptImageInput } from "../../media/prompt-image-input.js";
import type {
  CliBackendMessageInjection,
  CliBackendPromptContext,
} from "../../plugins/cli-backend.types.js";
import { isHostGeneratedInputProvenance } from "../../sessions/input-provenance.js";
import type {
  ReplyBackendMessageInjectionV2,
  ReplyBackendQueueMessageOptions,
  ReplyBackendQueueMessageResult,
} from "../../sessions/session-controller.contracts.js";
import { projectRuntimeContextFragments } from "../internal-runtime-context.js";
import { loadCliPromptImages } from "./helpers.js";
import { cliBackendLog } from "./log.js";
import { readCliPromptContext, toCliModelRequestPayload } from "./model-request-hook.js";
import type { PreparedCliRunContext } from "./types.js";

/** One host adapter owns final input admission and accepted transcript custody. */
export function createSteeredCliMessageInjection(params: {
  getInjection: () => CliBackendMessageInjection | undefined;
  signal: AbortSignal;
  /** Owning run: its working directory, media roots, and before_model_request gate. */
  context: {
    params: Pick<PreparedCliRunContext["params"], "cwd" | "workspaceDir" | "config" | "agentId">;
    backendResolved: Pick<PreparedCliRunContext["backendResolved"], "id">;
    beforeModelRequest?: PreparedCliRunContext["beforeModelRequest"];
  };
  /** Native owns the steered input; tool tracking starts a new input's reply state. */
  onInputSubmitted?: () => void;
}): ReplyBackendMessageInjectionV2 {
  const gate = params.context.beforeModelRequest;
  const queueMessage = async (
    text: string,
    options: ReplyBackendQueueMessageOptions | undefined,
    assertInjectionCurrent: () => void,
    prepareCurrent?: () => Promise<void>,
  ): Promise<ReplyBackendQueueMessageResult | undefined> => {
    const injection = params.getInjection();
    if (!injection) {
      throw new Error("CLI plugin runtime does not accept input during its turn.");
    }
    const cwd = params.context.params.cwd ?? params.context.params.workspaceDir;
    let accepted = false;
    let failure: Error | undefined;
    let result: ReplyBackendQueueMessageResult | undefined;
    const recorder = options?.userTurnTranscriptRecorder;
    try {
      const message = await recorder?.resolveMessage();
      // Same hydration as the turn's first prompt; admission already required acceptsImages.
      const images = hasPromptImageInput(options)
        ? await loadCliPromptImages({
            prompt: text,
            workspaceDir: params.context.params.workspaceDir,
            localRoots: getAgentScopedMediaLocalRoots(
              params.context.params.config ?? {},
              params.context.params.agentId,
            ),
            config: params.context.params.config,
            images: options?.images,
            imageOrder: options?.imageOrder,
            media: options?.media,
            userTurnTranscriptRecorder: recorder,
          })
        : [];
      const context = options?.currentInboundContext;
      let steeredText = text;
      let promptContext: CliBackendPromptContext | undefined = context
        ? {
            prependContext: labelRuntimeContextText(
              projectRuntimeContextFragments(
                context.fragments ?? [{ kind: "conversation-data", text: context.text }],
              ),
            ),
          }
        : undefined;
      // Steered input reaches the model without a new turn; gate it like the turn prompt.
      if (gate) {
        const request = await gate(
          toCliModelRequestPayload(steeredText, promptContext),
          message ?? { role: "user", content: text },
        );
        steeredText = request.prompt;
        promptContext = readCliPromptContext(request);
      }
      const nativeInput = await injection.queueMessage(
        steeredText,
        async (submit) => {
          let submitted = false;
          try {
            await withMessageInjectionAdmission(prepareCurrent, () => {
              // The same worker-backed admission owns source checks and native stdin.
              assertInjectionCurrent();
              submit();
              submitted = true;
              params.onInputSubmitted?.();
            });
          } catch (cause) {
            // Outer source cleanup can fail after native owns input, just like admission cleanup.
            if (submitted) {
              throw new MessageInjectionAcceptedUnconfirmedError({ cause });
            }
            throw cause;
          }
        },
        {
          ...(isHostGeneratedInputProvenance(message?.provenance)
            ? { promptOrigin: "host" as const }
            : {}),
          ...(promptContext ? { promptContext } : {}),
          ...(images.length > 0 ? { images } : {}),
        },
      );
      accepted = true;
      options?.onQueueAccepted?.(true);
      if (recorder && !recorder.hasPersisted() && !recorder.isBlocked()) {
        const persisted = await recorder.persistApproved({ cwd });
        if (!persisted && !recorder.hasPersisted() && (await recorder.resolveMessage())) {
          // Native owns the input, but an absent receipt does not prove write rejection.
          // Suppress outer fallback persistence without canceling independent active work.
          recorder.markBlocked();
          result = {
            transcriptCommit: "unconfirmed",
            errorMessage: "steered CLI user turn transcript commitment could not be confirmed",
          };
        }
      }
      if (
        nativeInput &&
        recorder?.hasPersisted() &&
        message &&
        readPersistedMediaFacts(message)?.some(isMeaningfulMediaFact)
      ) {
        options?.onNativeInputCommitted?.({
          importedFrom: params.context.backendResolved.id,
          cliSessionId: nativeInput.cliSessionId,
          externalId: nativeInput.externalId,
        });
      }
    } catch (error) {
      failure = toErrorObject(error, "CLI steering failed.");
    }
    try {
      // This receipt is terminal even when persistence failed; the registry retains
      // accepted-input disposition without replaying or canceling an unconfirmed turn.
      options?.onQueueSettled?.();
    } catch (error) {
      failure ??= toErrorObject(error, "CLI steering completion observer failed.");
    }
    if (failure) {
      if (!accepted) {
        throw failure;
      }
      // Completion observers can throw too. Never downgrade native acceptance to rejection.
      const errorMessage = `steered CLI user turn was not settled: ${formatErrorMessage(failure)}`;
      cliBackendLog.warn(errorMessage);
      return { transcriptCommit: "unconfirmed", errorMessage };
    }
    return result;
  };
  return {
    version: 2,
    isAvailable: () => !params.signal.aborted && params.getInjection()?.isAvailable() === true,
    queueMessage: (text, options, assertInjectionCurrent) =>
      queueMessage(text, options, assertInjectionCurrent),
    queueMessageAsync: (text, options, preparation) =>
      queueMessage(text, options, preparation.assertCurrent, preparation.prepareCurrent),
  };
}
