import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import { readByteStreamWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { danger, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { FsSafeError, readRegularFile } from "openclaw/plugin-sdk/security-runtime";
import {
  asRecord,
  normalizeOptionalString,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveBrowserActRequestTimeoutMs } from "../../browser/act-policy.js";
import type { browserAct } from "../../browser/client-actions.js";
import type { BrowserActRequest, BrowserFormField } from "../../browser/client-actions.types.js";
import { normalizeBrowserFormFields } from "../../browser/form-fields.js";
import {
  callBrowserRequest,
  printBrowserJsonResult,
  type BrowserParentOpts,
} from "../browser-cli-shared.js";

type BrowserActionResult = Awaited<ReturnType<typeof browserAct>>;

/** Execute and present an action, preserving recorded interruptions and child failures. */
export async function runBrowserAction(params: {
  parent: BrowserParentOpts;
  body: BrowserActRequest;
  successMessage?: string | ((result: BrowserActionResult) => string);
}): Promise<void> {
  const result = await callBrowserRequest<BrowserActionResult>(
    params.parent,
    {
      method: "POST",
      path: "/act",
      query: params.parent.browserProfile ? { profile: params.parent.browserProfile } : undefined,
      body: params.body,
    },
    { timeoutMs: resolveBrowserActRequestTimeoutMs(params.body) },
  );
  const { parent, successMessage } = params;
  const failures = (result.results ?? []).flatMap((entry, index) =>
    entry.ok ? [] : [`action ${index + 1}: ${entry.error ?? "failed"}`],
  );
  if (!printBrowserJsonResult(parent, result)) {
    if (failures.length) {
      defaultRuntime.error(danger(`batch failed: ${failures.join("; ")}`));
    }
    if (result.blockedByDialog) {
      const profile = normalizeOptionalString(parent.browserProfile);
      const pending = asRecord(asRecord(result.browserState).dialogs).pending;
      const ids = Array.isArray(pending)
        ? pending.flatMap((dialog) => {
            const id = readStringField(asRecord(dialog), "id");
            return id ? [JSON.stringify(id)] : [];
          })
        : [];
      defaultRuntime.log(
        `Action blocked by a modal dialog${ids.length ? ` (${ids.join(", ")})` : ""}. Use openclaw browser dialog${profile ? ` --browser-profile=${profile}` : ""} --accept or --dismiss${ids.length ? " --dialog-id <id>" : ""} to continue.`,
      );
    } else if (result.aborted) {
      const { reason, afterAction, skipped } = result.aborted;
      defaultRuntime.log(
        `Batch stopped after action ${afterAction}: page ${reason === "navigation" ? "navigated" : "closed"}; ${skipped} action(s) skipped. Take a fresh snapshot before continuing.`,
      );
    } else if (!failures.length) {
      if (successMessage !== undefined) {
        defaultRuntime.log(
          typeof successMessage === "function" ? successMessage(result) : successMessage,
        );
      } else {
        defaultRuntime.writeJson(result.result ?? null);
      }
    }
  }
  if (failures.length) {
    defaultRuntime.exit(1);
  }
}

export function requireRef(ref: string | undefined) {
  const refValue = typeof ref === "string" ? ref.trim() : "";
  if (!refValue) {
    throw new Error("ref is required");
  }
  return refValue;
}

function decodeJsonInput(buffer: Buffer, source: string): string {
  if (!isUtf8(buffer)) {
    throw new Error(`${source} must be valid UTF-8.`);
  }
  return buffer.toString("utf8");
}

export async function readFields(opts: {
  fields?: string;
  fieldsFile?: string;
}): Promise<BrowserFormField[]> {
  if (opts.fields !== undefined && opts.fieldsFile !== undefined) {
    throw new Error("Specify only one of --fields or --fields-file");
  }
  const payload = opts.fieldsFile
    ? decodeJsonInput(await fs.readFile(opts.fieldsFile), "--fields-file")
    : (opts.fields ?? "");
  return normalizeBrowserFormFields(parseBrowserInputArray(payload, "fields"));
}

export function parseBrowserInputArray(payload: string, kind: "fields" | "actions"): unknown[] {
  if (!payload.trim()) {
    throw new Error(`${kind} are required`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new Error(`${kind} must be valid JSON${kind === "fields" ? "." : ""}`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${kind} must be ${kind === "fields" ? "an array" : "a JSON array"}`);
  }
  return parsed;
}

const ACTIONS_INPUT_MAX_BYTES = 1_000_000;

function createActionsInputTooLargeError(source: string, cause?: unknown): FsSafeError {
  return new FsSafeError(
    "too-large",
    `${source} exceeds ${ACTIONS_INPUT_MAX_BYTES} bytes. Split the batch plan into smaller files or run multiple openclaw browser batch commands.`,
    { cause },
  );
}

export async function readActionsPayload(opts: {
  actions?: string;
  actionsFile?: string;
}): Promise<string> {
  if (opts.actionsFile) {
    if (opts.actionsFile === "-") {
      const bytes = await readByteStreamWithLimit(process.stdin, {
        maxBytes: ACTIONS_INPUT_MAX_BYTES,
        onOverflow: () => createActionsInputTooLargeError("--actions-file - stdin"),
      });
      return decodeJsonInput(bytes, "--actions-file - stdin");
    }
    const filePath = opts.actionsFile;
    try {
      // Preserve existing symlinked inputs while rejecting oversized files and FIFOs.
      const { buffer } = await readRegularFile({
        filePath: await fs.realpath(filePath),
        maxBytes: ACTIONS_INPUT_MAX_BYTES,
      });
      return decodeJsonInput(buffer, "--actions-file");
    } catch (cause) {
      if (cause instanceof FsSafeError && cause.code === "too-large") {
        throw createActionsInputTooLargeError("--actions-file", cause);
      }
      throw cause;
    }
  }
  return opts.actions ?? "";
}
