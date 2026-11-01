export type BrowserFormField = {
  ref: string;
  type: string;
  value?: string | number | boolean;
};

type BrowserElementActionTarget = {
  ref?: string;
  selector?: string;
  timeoutMs?: number;
};

/** Normalized browser action request sent to the control server. */
export type BrowserActRequest = { targetId?: string } & (
  | (BrowserElementActionTarget & {
      kind: "click";
      doubleClick?: boolean;
      button?: string;
      modifiers?: string[];
      delayMs?: number;
    })
  | {
      kind: "clickCoords";
      x: number;
      y: number;
      doubleClick?: boolean;
      button?: string;
      delayMs?: number;
      timeoutMs?: number;
    }
  | (BrowserElementActionTarget & {
      kind: "type";
      text: string;
      submit?: boolean;
      slowly?: boolean;
    })
  | { kind: "press"; key: string; delayMs?: number }
  | { kind: "insertText"; text: string }
  | (BrowserElementActionTarget & { kind: "hover" })
  | (BrowserElementActionTarget & { kind: "scrollIntoView" })
  | {
      kind: "drag";
      startRef?: string;
      startSelector?: string;
      endRef?: string;
      endSelector?: string;
      timeoutMs?: number;
    }
  | (BrowserElementActionTarget & {
      kind: "select";
      values: string[];
    })
  | {
      kind: "fill";
      fields: BrowserFormField[];
      timeoutMs?: number;
    }
  | { kind: "resize"; width: number; height: number }
  | {
      kind: "wait";
      timeMs?: number;
      text?: string;
      textGone?: string;
      selector?: string;
      url?: string;
      loadState?: "load" | "domcontentloaded" | "networkidle";
      fn?: string;
      timeoutMs?: number;
    }
  | { kind: "evaluate"; fn: string; ref?: string; timeoutMs?: number }
  | { kind: "close" }
  | {
      kind: "batch";
      actions: BrowserActRequest[];
      stopOnError?: boolean;
    }
);
