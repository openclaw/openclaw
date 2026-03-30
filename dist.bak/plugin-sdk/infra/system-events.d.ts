export type SystemEvent = {
    text: string;
    ts: number;
    contextKey?: string | null;
};
type SystemEventOptions = {
    sessionKey: string;
    contextKey?: string | null;
};
export declare function isSystemEventContextChanged(sessionKey: string, contextKey?: string | null): boolean;
export declare function enqueueSystemEvent(text: string, options: SystemEventOptions): boolean;
export declare function drainSystemEventEntries(sessionKey: string): SystemEvent[];
export declare function drainSystemEvents(sessionKey: string): string[];
export declare function peekSystemEventEntries(sessionKey: string): SystemEvent[];
export declare function peekSystemEvents(sessionKey: string): string[];
export declare function hasSystemEvents(sessionKey: string): boolean;
export declare function resetSystemEventsForTest(): void;
export {};
