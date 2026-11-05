import type { CDPSession } from "playwright-core";
/** Native accessibility node fields used by browser snapshots. */
export type RawAXNode = {
  nodeId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
  properties?: { name: string; value: { value?: unknown } }[];
};

export function axValue(v: unknown): string {
  if (!v || typeof v !== "object" || !("value" in v)) {
    return "";
  }
  const value = v.value;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

declare const playwrightCdpSend: CDPSession["send"];
type CdpMethod = Parameters<typeof playwrightCdpSend>[0];

/** Native command inputs follow Playwright's public protocol contract; raw replies remain unknown. */
export type CdpProtocolSend = <Method extends CdpMethod>(
  method: Method,
  params?: Parameters<typeof playwrightCdpSend<Method>>[1],
  sessionId?: string,
) => Promise<unknown>;
/** Normalized accessibility tree node returned by ARIA snapshots. */
export type AriaSnapshotNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  backendDOMNodeId?: number;
  depth: number;
};
