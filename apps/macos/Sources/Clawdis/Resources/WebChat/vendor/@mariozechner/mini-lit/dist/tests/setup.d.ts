import { Window } from "happy-dom";
export declare function setupDOM(): {
    window: Window;
    document: import("happy-dom").Document;
};
export declare function cleanupDOM(window: any): void;
export declare function nextTick(): Promise<unknown>;
export declare class MemoryTracker {
    private refs;
    track(obj: any): void;
    getAliveCount(): number;
    clear(): void;
}
export declare class ErrorCapture {
    private errors;
    private originalError;
    start(): void;
    stop(): void;
    get(): any[];
    clear(): void;
}
//# sourceMappingURL=setup.d.ts.map