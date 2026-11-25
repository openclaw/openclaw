export type LaneDeliveryStateTracker = ReturnType<typeof createLaneDeliveryStateTracker>;

export function createLaneDeliveryStateTracker() {
  const state = {
    delivered: false,
    skippedNonSilent: 0,
    failedNonSilent: 0,
  };
  return {
    markDelivered: () => {
      state.delivered = true;
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
