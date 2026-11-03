export type EmbeddedRunReplayState = {
  replayInvalid: boolean;
  hadPotentialSideEffects: boolean;
};

/** Serializable replay metadata stored with run results. */
export type EmbeddedRunReplayMetadata = {
  hadPotentialSideEffects: boolean;
  replaySafe: boolean;
};

export function createEmbeddedRunReplayState(
  state?: Partial<EmbeddedRunReplayState>,
): EmbeddedRunReplayState {
  return {
    replayInvalid: state?.replayInvalid === true,
    hadPotentialSideEffects: state?.hadPotentialSideEffects === true,
  };
}

/** Merges replay state monotonically so unsafe observations cannot be cleared accidentally. */
export function mergeEmbeddedRunReplayState(
  current: EmbeddedRunReplayState,
  next?: Partial<EmbeddedRunReplayState>,
): EmbeddedRunReplayState {
  if (!next) {
    return current;
  }
  return {
    replayInvalid: current.replayInvalid || next.replayInvalid === true,
    hadPotentialSideEffects:
      current.hadPotentialSideEffects || next.hadPotentialSideEffects === true,
  };
}

export function observeReplayMetadata(
  current: EmbeddedRunReplayState,
  metadata?: EmbeddedRunReplayMetadata | null,
): EmbeddedRunReplayState {
  // An opaque run cannot prove replay safety or the absence of side effects.
  return mergeEmbeddedRunReplayState(current, {
    replayInvalid: !metadata?.replaySafe,
    hadPotentialSideEffects: metadata ? metadata.hadPotentialSideEffects : true,
  });
}

export function replayMetadataFromState(state: EmbeddedRunReplayState): EmbeddedRunReplayMetadata {
  return {
    hadPotentialSideEffects: state.hadPotentialSideEffects,
    replaySafe: !state.replayInvalid && !state.hadPotentialSideEffects,
  };
}
