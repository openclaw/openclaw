import type { ControlUiChannelSettingsContext } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { NostrProfile } from "./types.ts";

const NOSTR_PROFILE_REQUEST_TIMEOUT_MS = 30_000;

type NostrProfileRequest = {
  accountId: string;
  context: ControlUiChannelSettingsContext;
  signal: AbortSignal;
};

async function requestNostrProfile(
  auth: NostrProfileRequest,
  method: "PUT" | "POST",
  body: unknown,
  suffix: readonly string[] = [],
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException("Nostr profile request timed out after 30 seconds", "TimeoutError"),
      ),
    NOSTR_PROFILE_REQUEST_TIMEOUT_MS,
  );
  try {
    return await auth.context.request({
      accountId: auth.accountId,
      path: ["profile", ...suffix],
      method,
      body,
      signal: AbortSignal.any([auth.signal, controller.signal]),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function parseValidationErrors(
  details: unknown,
  formatExternalText: (text: string) => string,
): Record<string, string> {
  if (!Array.isArray(details)) {
    return {};
  }
  const errors: Record<string, string> = {};
  for (const entry of details) {
    if (typeof entry !== "string") {
      continue;
    }
    const [rawField, ...rest] = entry.split(":");
    if (!rawField || rest.length === 0) {
      continue;
    }
    const field = rawField.trim();
    const message = rest.join(":").trim();
    if (field && message) {
      errors[field] = formatExternalText(message);
    }
  }
  return errors;
}

export function putNostrProfile(
  params: NostrProfileRequest & {
    values: NostrProfile;
  },
) {
  return requestNostrProfile(params, "PUT", params.values);
}

function isNostrProfile(value: unknown): value is NostrProfile {
  return (
    isRecord(value) &&
    ["name", "displayName", "about", "picture", "banner", "website", "nip05", "lud16"].every(
      (field) =>
        value[field] === undefined || value[field] === null || typeof value[field] === "string",
    )
  );
}

export async function importNostrProfile(params: NostrProfileRequest) {
  const result = await requestNostrProfile(params, "POST", { autoMerge: true }, ["import"]);
  return {
    ...result,
    data: result.data && {
      ...result.data,
      ok: result.data.ok,
      saved: result.data.saved,
      imported: isNostrProfile(result.data.imported) ? result.data.imported : undefined,
      merged: isNostrProfile(result.data.merged) ? result.data.merged : undefined,
    },
  };
}
