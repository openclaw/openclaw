export type EmbeddedRunReplayState = {
    replayInvalid: boolean;
    hadPotentialSideEffects: boolean;
};
export type EmbeddedRunReplayMetadata = {
    hadPotentialSideEffects: boolean;
    replaySafe: boolean;
};
export declare function createEmbeddedRunReplayState(state?: Partial<EmbeddedRunReplayState>): EmbeddedRunReplayState;
export declare function mergeEmbeddedRunReplayState(current: EmbeddedRunReplayState, next?: Partial<EmbeddedRunReplayState>): EmbeddedRunReplayState;
export declare function observeReplayMetadata(current: EmbeddedRunReplayState, metadata?: EmbeddedRunReplayMetadata | null): EmbeddedRunReplayState;
export declare function replayMetadataFromState(state: EmbeddedRunReplayState): EmbeddedRunReplayMetadata;
