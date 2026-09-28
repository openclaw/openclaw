import type { BrowserActErrorCode } from "../errors.js";
import type { BrowserResponse } from "./types.js";

export function jsonActError(
  res: BrowserResponse,
  status: number,
  code: BrowserActErrorCode,
  message: string,
) {
  res.status(status).json({ error: message, code });
}

export function browserEvaluateDisabledMessage(action: "wait" | "evaluate"): string {
  return [
    action === "wait"
      ? "wait --fn is disabled by config (browser.evaluateEnabled=false)."
      : "act:evaluate is disabled by config (browser.evaluateEnabled=false).",
    "Docs: /tools/browser/configuration#configuration",
  ].join("\n");
}
