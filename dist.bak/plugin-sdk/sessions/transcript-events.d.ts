type SessionTranscriptUpdate = {
    sessionFile: string;
};
type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;
export declare function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void;
export declare function emitSessionTranscriptUpdate(sessionFile: string): void;
export {};
