import type { createMattermostDraftStream } from "./draft-stream.js";
import { formatMattermostTerminalProgressText } from "./monitor-context.js";

type SeparateProgressDraft = Pick<
  ReturnType<typeof createMattermostDraftStream>,
  "retainTerminalText"
>;

export function createMattermostSeparateProgressController(params: {
  enabled: boolean;
  pinnedLabel?: string;
  draftStream: SeparateProgressDraft;
  hasSuccessfulFinal: () => boolean;
  logVerboseMessage: (message: string) => void;
}) {
  let terminalProgressPromise: Promise<void> | undefined;

  const markFailed = async () => {
    if (!params.enabled || params.hasSuccessfulFinal()) {
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
      if (!params.enabled || (result.visibleReplySent && !isError) || params.hasSuccessfulFinal()) {
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
    settleTurnError: async () => {
      try {
        await markFailed();
      } catch (error) {
        logFailure(error);
      }
    },
  };
}
