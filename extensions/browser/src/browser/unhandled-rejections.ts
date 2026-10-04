import { collectErrorGraphCandidates } from "openclaw/plugin-sdk/error-runtime";
import { registerUnhandledRejectionHandler } from "openclaw/plugin-sdk/runtime-env";
import { asOptionalObjectRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";

const PLAYWRIGHT_DIALOG_METHODS = new Set([
  "Page.handleJavaScriptDialog",
  "Dialog.handleJavaScriptDialog",
]);

const NO_DIALOG_MESSAGE = "no dialog is showing";

function isPlaywrightDialogRaceUnhandledRejection(reason: unknown): boolean {
  for (const candidate of collectErrorGraphCandidates(reason, (current) => [
    current.cause,
    current.reason,
    current.original,
    current.error,
    current.data,
    ...(Array.isArray(current.errors) ? current.errors : []),
  ])) {
    const error = asOptionalObjectRecord(candidate);
    const message =
      typeof candidate === "string" ? candidate : (readStringField(error, "message") ?? "");
    const normalizedMessage = message.toLowerCase();
    if (!normalizedMessage.includes(NO_DIALOG_MESSAGE)) {
      continue;
    }

    const method = readStringField(error, "method");
    if (method && PLAYWRIGHT_DIALOG_METHODS.has(method)) {
      return true;
    }
    for (const playwrightMethod of PLAYWRIGHT_DIALOG_METHODS) {
      if (message.includes(playwrightMethod)) {
        return true;
      }
    }
  }

  return false;
}

export function registerBrowserUnhandledRejectionHandler(): () => void {
  return registerUnhandledRejectionHandler(isPlaywrightDialogRaceUnhandledRejection);
}
