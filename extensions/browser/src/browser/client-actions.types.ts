export type BrowserFormField = {
  ref: string;
  type: string;
  value?: string | number | boolean;
};

/** Normalized browser action request sent to the control server. */
export type BrowserActRequest = { targetId?: string } & (
  | {
      kind: "click";
      ref?: string;
      selector?: string;
      doubleClick?: boolean;
      button?: string;
      modifiers?: string[];
      delayMs?: number;
      timeoutMs?: number;
    }
  | {
      kind: "clickCoords";
      x: number;
      y: number;
      doubleClick?: boolean;
      button?: string;
      delayMs?: number;
      timeoutMs?: number;
    }
  | {
      kind: "type";
      ref?: string;
      selector?: string;
      text: string;
      submit?: boolean;
      slowly?: boolean;
      timeoutMs?: number;
    }
  | { kind: "press"; key: string; delayMs?: number }
  | { kind: "insertText"; text: string }
  | {
      kind: "hover";
      ref?: string;
      selector?: string;
      timeoutMs?: number;
    }
  | {
      kind: "scrollIntoView";
      ref?: string;
      selector?: string;
      timeoutMs?: number;
    }
  | {
      kind: "drag";
      startRef?: string;
      startSelector?: string;
      endRef?: string;
      endSelector?: string;
      timeoutMs?: number;
    }
  | {
      kind: "select";
      ref?: string;
      selector?: string;
      values: string[];
      timeoutMs?: number;
    }
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
