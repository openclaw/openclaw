import type { BrowserFormField } from "./client-actions-core.js";
export declare function highlightViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
}): Promise<void>;
export declare function clickViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
    timeoutMs?: number;
}): Promise<void>;
export declare function hoverViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    timeoutMs?: number;
}): Promise<void>;
export declare function dragViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    startRef: string;
    endRef: string;
    timeoutMs?: number;
}): Promise<void>;
export declare function selectOptionViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    values: string[];
    timeoutMs?: number;
}): Promise<void>;
export declare function pressKeyViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    key: string;
    delayMs?: number;
}): Promise<void>;
export declare function typeViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    text: string;
    submit?: boolean;
    slowly?: boolean;
    timeoutMs?: number;
}): Promise<void>;
export declare function fillFormViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    fields: BrowserFormField[];
    timeoutMs?: number;
}): Promise<void>;
export declare function evaluateViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    fn: string;
    ref?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<unknown>;
export declare function scrollIntoViewViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    timeoutMs?: number;
}): Promise<void>;
export declare function waitForViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    timeMs?: number;
    text?: string;
    textGone?: string;
    selector?: string;
    url?: string;
    loadState?: "load" | "domcontentloaded" | "networkidle";
    fn?: string;
    timeoutMs?: number;
}): Promise<void>;
export declare function takeScreenshotViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref?: string;
    element?: string;
    fullPage?: boolean;
    type?: "png" | "jpeg";
}): Promise<{
    buffer: Buffer;
}>;
export declare function screenshotWithLabelsViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    refs: Record<string, {
        role: string;
        name?: string;
        nth?: number;
    }>;
    maxLabels?: number;
    type?: "png" | "jpeg";
}): Promise<{
    buffer: Buffer;
    labels: number;
    skipped: number;
}>;
export declare function setInputFilesViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    inputRef?: string;
    element?: string;
    paths: string[];
}): Promise<void>;
