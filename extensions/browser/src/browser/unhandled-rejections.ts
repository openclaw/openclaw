import { registerUnhandledRejectionHandler } from "openclaw/plugin-sdk/runtime-env";

const PLAYWRIGHT_DIALOG_RACE_MESSAGE_SNIPPETS = [
  "page.handlejavascriptdialog",
  "no dialog is showing",
];

function collectNestedErrorCandidates(reason: unknown): unknown[] {
  const candidates: unknown[] = [];
  const queue: unknown[] = [reason];
  const seen = new WeakSet<object>();

  while (queue.length > 0 && candidates.length < 64) {
    const current = queue.shift();
    candidates.push(current);

    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    const record = current as {
      cause?: unknown;
      reason?: unknown;
      original?: unknown;
      error?: unknown;
      data?: unknown;
      errors?: unknown;
    };
    queue.push(record.cause, record.reason, record.original, record.error, record.data);
    if (Array.isArray(record.errors)) {
      queue.push(...record.errors);
    }
  }

  return candidates;
}

export function isPlaywrightDialogRaceUnhandledRejection(reason: unknown): boolean {
  for (const candidate of collectNestedErrorCandidates(reason)) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const rawMessage = (candidate as { message?: unknown }).message;
    const message = typeof rawMessage === "string" ? rawMessage.toLowerCase() : "";
    if (
      message &&
      PLAYWRIGHT_DIALOG_RACE_MESSAGE_SNIPPETS.every((snippet) => message.includes(snippet))
    ) {
      return true;
    }
  }

  return false;
}

export function registerBrowserUnhandledRejectionHandler(): () => void {
  return registerUnhandledRejectionHandler(isPlaywrightDialogRaceUnhandledRejection);
}
