import JSON5 from "json5";
import type { ConfigDraft } from "./config-store.ts";

export type Json5Preview = {
  text: string;
  lineCount: number;
  byteCount: number;
};

export function formatConfigJson5(config: ConfigDraft): Json5Preview {
  const text = `${JSON5.stringify(config, null, 2)}\n`;
  const lineCount = text.split(/\r?\n/).length - 1;
  const byteCount = new TextEncoder().encode(text).byteLength;
  return {
    text,
    lineCount,
    byteCount,
  };
}

export function downloadJson5File(text: string, filename = "openclaw.json"): void {
  if (typeof document === "undefined") {
    return;
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
