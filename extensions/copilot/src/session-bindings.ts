import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sessionAuthFields } from "./auth-bridge.js";

export type CopilotSessionBinding = {
  schemaVersion: 2;
  journalVersion?: 1;
  sdkSessionId: string;
  // A provider/model/cwd/auth change starts a fresh SDK session instead of resuming.
  compatKey: string;
  compactKey: string;
  authMode: "gitHubToken" | "useLoggedInUser" | "byok";
  authProfileId?: string;
  authProfileVersion?: string;
  updatedAt: number;
};

type CopilotAttemptSessionBinding = Pick<
  CopilotSessionBinding,
  "compatKey" | "journalVersion" | "sdkSessionId"
>;
export type CopilotSessionBindingStore = Pick<
  PluginStateKeyedStore<CopilotSessionBinding>,
  "delete" | "lookup" | "register"
>;

function normalizeBinding(value: Record<string, unknown>): CopilotSessionBinding | undefined {
  const authProfileId = typeof value.authProfileId === "string" ? value.authProfileId : undefined;
  const authProfileVersion =
    typeof value.authProfileVersion === "string" ? value.authProfileVersion : undefined;
  if (
    value.schemaVersion !== 2 ||
    typeof value.sdkSessionId !== "string" ||
    value.sdkSessionId.trim() === "" ||
    typeof value.compatKey !== "string" ||
    value.compatKey.trim() === "" ||
    typeof value.compactKey !== "string" ||
    value.compactKey.trim() === "" ||
    (value.journalVersion !== undefined && value.journalVersion !== 1) ||
    (value.authMode !== "gitHubToken" &&
      value.authMode !== "byok" &&
      value.authMode !== "useLoggedInUser") ||
    ((value.authMode === "gitHubToken" || value.authMode === "byok") &&
      (!authProfileId?.trim() || !authProfileVersion?.trim())) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 2,
    ...(value.journalVersion === 1 ? { journalVersion: 1 as const } : {}),
    sdkSessionId: value.sdkSessionId.trim(),
    compatKey: value.compatKey,
    compactKey: value.compactKey,
    ...sessionAuthFields({ authMode: value.authMode, authProfileId, authProfileVersion }),
    updatedAt: value.updatedAt,
  };
}

function normalizeAttemptBinding(value: unknown): CopilotAttemptSessionBinding | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const current = normalizeBinding(value);
  if (current) {
    return current;
  }
  const legacy = value;
  if (
    legacy.schemaVersion !== 1 ||
    typeof legacy.sdkSessionId !== "string" ||
    legacy.sdkSessionId.trim() === "" ||
    typeof legacy.compatKey !== "string" ||
    legacy.compatKey.trim() === "" ||
    typeof legacy.updatedAt !== "number" ||
    !Number.isFinite(legacy.updatedAt)
  ) {
    return undefined;
  }
  return {
    sdkSessionId: legacy.sdkSessionId.trim(),
    compatKey: legacy.compatKey,
  };
}

export async function lookupStoredBinding(
  store: CopilotSessionBindingStore | undefined,
  key: string,
): Promise<CopilotAttemptSessionBinding | undefined> {
  try {
    return normalizeAttemptBinding(await store?.lookup(key));
  } catch {
    await deleteStoredBinding(store, key);
    return undefined;
  }
}

export async function registerStoredBinding(
  store: CopilotSessionBindingStore | undefined,
  key: string,
  binding: Omit<CopilotSessionBinding, "schemaVersion" | "updatedAt">,
): Promise<void> {
  const stored: CopilotSessionBinding = {
    schemaVersion: 2,
    ...(binding.journalVersion === 1 ? { journalVersion: 1 } : {}),
    sdkSessionId: binding.sdkSessionId,
    compatKey: binding.compatKey,
    compactKey: binding.compactKey,
    ...sessionAuthFields(binding),
    updatedAt: Date.now(),
  };
  try {
    await store?.register(key, stored);
  } catch {
    await deleteStoredBinding(store, key);
  }
}

export async function deleteStoredBinding(
  store: CopilotSessionBindingStore | undefined,
  key: string,
): Promise<boolean> {
  try {
    await store?.delete(key);
    return true;
  } catch {
    // Failed durable cleanup must not block fresh sessions or tracked-session reset.
    return false;
  }
}
