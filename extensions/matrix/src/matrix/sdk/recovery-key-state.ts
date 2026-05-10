import { createHash } from "node:crypto";
import path from "node:path";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { withMatrixSqliteStateEnv } from "../sqlite-state.js";
import type { MatrixStoredRecoveryKey } from "./types.js";

export const MATRIX_RECOVERY_KEY_NAMESPACE = "recovery-key";

const RECOVERY_KEY_STORE = createPluginStateSyncKeyedStore<MatrixStoredRecoveryKey>("matrix", {
  namespace: MATRIX_RECOVERY_KEY_NAMESPACE,
  maxEntries: 10_000,
});

export function resolveMatrixRecoveryKeyStateKey(recoveryKeyPath: string): string {
  return createHash("sha256")
    .update(path.resolve(recoveryKeyPath), "utf8")
    .digest("hex")
    .slice(0, 32);
}

function resolveStateDirFromRecoveryKeyPath(recoveryKeyPath: string): string | undefined {
  const parts = path.resolve(recoveryKeyPath).split(path.sep);
  const matrixIndex = parts.lastIndexOf("matrix");
  if (matrixIndex <= 0) {
    return undefined;
  }
  return parts.slice(0, matrixIndex).join(path.sep) || path.sep;
}

function toPlainJsonValue(value: unknown, seen = new WeakSet<object>()): unknown | undefined {
  if (value === null) {
    return null;
  }
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") {
    return value;
  }
  if (valueType === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (valueType !== "object") {
    return undefined;
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return undefined;
  }
  seen.add(objectValue);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        const normalized = toPlainJsonValue(item, seen);
        if (normalized === undefined) {
          return undefined;
        }
        items.push(normalized);
      }
      return items;
    }
    if (Object.getPrototypeOf(objectValue) !== Object.prototype) {
      return undefined;
    }
    const output: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      const normalized = toPlainJsonValue(entryValue, seen);
      if (normalized !== undefined) {
        output[key] = normalized;
      }
    }
    return output;
  } finally {
    seen.delete(objectValue);
  }
}

function normalizeMatrixRecoveryKeyInfo(
  value: unknown,
): MatrixStoredRecoveryKey["keyInfo"] | undefined {
  const parsed =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { passphrase?: unknown; name?: unknown })
      : {};
  const keyInfo: MatrixStoredRecoveryKey["keyInfo"] = {};
  const passphrase = toPlainJsonValue(parsed.passphrase);
  if (passphrase !== undefined) {
    keyInfo.passphrase = passphrase;
  }
  if (typeof parsed.name === "string") {
    keyInfo.name = parsed.name;
  }
  return Object.keys(keyInfo).length > 0 ? keyInfo : undefined;
}

function normalizeMatrixRecoveryKey(raw: unknown): MatrixStoredRecoveryKey | null {
  const parsed =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Partial<MatrixStoredRecoveryKey>)
      : {};
  if (
    parsed.version !== 1 ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.privateKeyBase64 !== "string" ||
    !parsed.privateKeyBase64.trim()
  ) {
    return null;
  }
  const normalized: MatrixStoredRecoveryKey = {
    version: 1,
    createdAt: parsed.createdAt,
    keyId: typeof parsed.keyId === "string" ? parsed.keyId : null,
    privateKeyBase64: parsed.privateKeyBase64,
  };
  if (typeof parsed.encodedPrivateKey === "string") {
    normalized.encodedPrivateKey = parsed.encodedPrivateKey;
  }
  const keyInfo = normalizeMatrixRecoveryKeyInfo(parsed.keyInfo);
  if (keyInfo) {
    normalized.keyInfo = keyInfo;
  }
  return normalized;
}

export function readMatrixRecoveryKey(recoveryKeyPath: string): MatrixStoredRecoveryKey | null {
  const stateDir = resolveStateDirFromRecoveryKeyPath(recoveryKeyPath);
  return withMatrixSqliteStateEnv(stateDir ? { stateDir } : undefined, () =>
    normalizeMatrixRecoveryKey(
      RECOVERY_KEY_STORE.lookup(resolveMatrixRecoveryKeyStateKey(recoveryKeyPath)),
    ),
  );
}

export function writeMatrixRecoveryKey(
  recoveryKeyPath: string,
  payload: MatrixStoredRecoveryKey,
): void {
  const normalized = normalizeMatrixRecoveryKey(payload);
  if (!normalized) {
    return;
  }
  const stateDir = resolveStateDirFromRecoveryKeyPath(recoveryKeyPath);
  withMatrixSqliteStateEnv(stateDir ? { stateDir } : undefined, () => {
    RECOVERY_KEY_STORE.register(resolveMatrixRecoveryKeyStateKey(recoveryKeyPath), normalized);
  });
}
