import type { SsrFPolicy } from "../infra/net/ssrf.js";
export { appendCdpPath, fetchJson, fetchOk, getHeadersWithAuth } from "./cdp.helpers.js";
export declare function normalizeCdpWsUrl(wsUrl: string, cdpUrl: string): string;
export declare function captureScreenshotPng(opts: {
    wsUrl: string;
    fullPage?: boolean;
}): Promise<Buffer>;
export declare function captureScreenshot(opts: {
    wsUrl: string;
    fullPage?: boolean;
    format?: "png" | "jpeg";
    quality?: number;
}): Promise<Buffer>;
export declare function createTargetViaCdp(opts: {
    cdpUrl: string;
    url: string;
    ssrfPolicy?: SsrFPolicy;
}): Promise<{
    targetId: string;
}>;
export type CdpRemoteObject = {
    type: string;
    subtype?: string;
    value?: unknown;
    description?: string;
    unserializableValue?: string;
    preview?: unknown;
};
export type CdpExceptionDetails = {
    text?: string;
    lineNumber?: number;
    columnNumber?: number;
    exception?: CdpRemoteObject;
    stackTrace?: unknown;
};
export declare function evaluateJavaScript(opts: {
    wsUrl: string;
    expression: string;
    awaitPromise?: boolean;
    returnByValue?: boolean;
}): Promise<{
    result: CdpRemoteObject;
    exceptionDetails?: CdpExceptionDetails;
}>;
export type AriaSnapshotNode = {
    ref: string;
    role: string;
    name: string;
    value?: string;
    description?: string;
    backendDOMNodeId?: number;
    depth: number;
};
export type RawAXNode = {
    nodeId?: string;
    role?: {
        value?: string;
    };
    name?: {
        value?: string;
    };
    value?: {
        value?: string;
    };
    description?: {
        value?: string;
    };
    childIds?: string[];
    backendDOMNodeId?: number;
};
export declare function formatAriaSnapshot(nodes: RawAXNode[], limit: number): AriaSnapshotNode[];
export declare function snapshotAria(opts: {
    wsUrl: string;
    limit?: number;
}): Promise<{
    nodes: AriaSnapshotNode[];
}>;
export declare function snapshotDom(opts: {
    wsUrl: string;
    limit?: number;
    maxTextChars?: number;
}): Promise<{
    nodes: DomSnapshotNode[];
}>;
export type DomSnapshotNode = {
    ref: string;
    parentRef: string | null;
    depth: number;
    tag: string;
    id?: string;
    className?: string;
    role?: string;
    name?: string;
    text?: string;
    href?: string;
    type?: string;
    value?: string;
};
export declare function getDomText(opts: {
    wsUrl: string;
    format: "html" | "text";
    maxChars?: number;
    selector?: string;
}): Promise<{
    text: string;
}>;
export declare function querySelector(opts: {
    wsUrl: string;
    selector: string;
    limit?: number;
    maxTextChars?: number;
    maxHtmlChars?: number;
}): Promise<{
    matches: QueryMatch[];
}>;
export type QueryMatch = {
    index: number;
    tag: string;
    id?: string;
    className?: string;
    text?: string;
    value?: string;
    href?: string;
    outerHTML?: string;
};
