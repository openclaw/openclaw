// Telegram plugin module implements lane delivery state behavior.
type LaneDeliverySnapshot = {
  delivered: boolean;
  skippedNonSilent: number;
  failedNonSilent: number;
  terminalErrorDelivered: boolean;
  terminalErrorText?: string;
};

type LaneDeliveryStateTracker = {
  markDelivered: () => void;
  markTerminalErrorDelivered: (text?: string) => void;
  hasTerminalErrorDelivered: (text?: string) => boolean;
  markNonSilentSkip: () => void;
  markNonSilentFailure: () => void;
  snapshot: () => LaneDeliverySnapshot;
};

export function createLaneDeliveryStateTracker(): LaneDeliveryStateTracker {
  const state: LaneDeliverySnapshot = {
    delivered: false,
    skippedNonSilent: 0,
    failedNonSilent: 0,
    terminalErrorDelivered: false,
  };
  return {
    markDelivered: () => {
      state.delivered = true;
    },
    markTerminalErrorDelivered: (text?: string) => {
      state.delivered = true;
      state.terminalErrorDelivered = true;
      state.terminalErrorText = text?.trim() || undefined;
    },
    hasTerminalErrorDelivered: (text?: string) => {
      if (!state.terminalErrorDelivered) {
        return false;
      }
      const normalizedText = text?.trim();
      return (
        !normalizedText || !state.terminalErrorText || state.terminalErrorText === normalizedText
      );
    },
    markNonSilentSkip: () => {
      state.skippedNonSilent += 1;
    },
    markNonSilentFailure: () => {
      state.failedNonSilent += 1;
    },
    snapshot: () => ({ ...state }),
  };
}
