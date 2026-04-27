export function createEmbeddedRunReplayState(state) {
    return {
        replayInvalid: state?.replayInvalid === true,
        hadPotentialSideEffects: state?.hadPotentialSideEffects === true,
    };
}
export function mergeEmbeddedRunReplayState(current, next) {
    if (!next) {
        return current;
    }
    return {
        replayInvalid: current.replayInvalid || next.replayInvalid === true,
        hadPotentialSideEffects: current.hadPotentialSideEffects || next.hadPotentialSideEffects === true,
    };
}
export function observeReplayMetadata(current, metadata) {
    return mergeEmbeddedRunReplayState(current, {
        replayInvalid: !metadata.replaySafe,
        hadPotentialSideEffects: metadata.hadPotentialSideEffects,
    });
}
export function replayMetadataFromState(state) {
    return {
        hadPotentialSideEffects: state.hadPotentialSideEffects,
        replaySafe: !state.replayInvalid && !state.hadPotentialSideEffects,
    };
}
