export declare const SESSION_LABEL_MAX_LENGTH = 64;
export type ParsedSessionLabel = {
    ok: true;
    label: string;
} | {
    ok: false;
    error: string;
};
export declare function parseSessionLabel(raw: unknown): ParsedSessionLabel;
