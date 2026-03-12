export declare const MEDIA_TOKEN_RE: RegExp;
export declare function normalizeMediaSource(src: string): string;
export declare function splitMediaFromOutput(raw: string): {
    text: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    audioAsVoice?: boolean;
};
