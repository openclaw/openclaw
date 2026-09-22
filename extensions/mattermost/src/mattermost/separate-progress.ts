import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { createMattermostDraftStream } from "./draft-stream.js";
import { formatMattermostTerminalProgressText } from "./monitor-context.js";

type SeparateProgressDraft = Pick<
  ReturnType<typeof createMattermostDraftStream>,
  "retainTerminalText"
>;

export async function discardMattermostSeparateProgressPending(params: {
  enabled: boolean;
  discardPending: () => Promise<void>;
  logVerboseMessage: (message: string) => void;
}) {
  try {
    await params.discardPending();
  } catch (error) {
    if (!params.enabled || !isChannelPartialDeliveryError(error)) {
      throw error;
    }
    params.logVerboseMessage(
      `mattermost separate progress receipt incomplete before final delivery: ${formatErrorMessage(error)}`,
    );
  }
}

export function createMattermostSeparateProgressController(params: {
  enabled: boolean;
  pinnedLabel?: string;
  draftStream: SeparateProgressDraft;
  hasAcceptedFinal: () => boolean;
  logVerboseMessage: (message: string) => void;
}) {
  let terminalProgressPromise: Promise<void> | undefined;
  let deliveryErrorSettlement: Promise<void> | undefined;

  const markFailed = async () => {
    if (!params.enabled || params.hasAcceptedFinal()) {
      return;
    }
    if (!terminalProgressPromise) {
      terminalProgressPromise = params.draftStream
        .retainTerminalText(formatMattermostTerminalProgressText(params.pinnedLabel))
        .then((retained) => {
          if (!retained) {
            throw new Error("Mattermost terminal progress was not retained");
          }
        });
    }
    const attempt = terminalProgressPromise;
    try {
      await attempt;
    } catch (error) {
      if (terminalProgressPromise === attempt) {
        terminalProgressPromise = undefined;
      }
      throw error;
    }
  };

  const logFailure = (error: unknown) => {
    params.logVerboseMessage(`mattermost terminal progress update failed: ${String(error)}`);
  };

  const settleObservedFailure = async () => {
    try {
      await markFailed();
    } catch (error) {
      logFailure(error);
    }
  };

  return {
    prepareFinal: async (isError: boolean) => {
      if (!isError) {
        return;
      }
      try {
        await markFailed();
      } catch (error) {
        logFailure(error);
      }
    },
    settleFinal: async (result: { visibleReplySent: boolean }, isError: boolean) => {
      if (!params.enabled || (result.visibleReplySent && !isError) || params.hasAcceptedFinal()) {
        return;
      }
      try {
        await markFailed();
      } catch (error) {
        if (!result.visibleReplySent) {
          throw error;
        }
        logFailure(error);
      }
    },
    observeDeliveryError: () => {
      deliveryErrorSettlement ??= settleObservedFailure();
    },
    settlePendingDeliveryError: async () => {
      await deliveryErrorSettlement;
    },
    settleTurnError: settleObservedFailure,
  };
}
