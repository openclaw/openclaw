import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";

export const MATRIX_CONFIG_STRING_FIELDS = [
  "homeserver",
  "userId",
  "accessToken",
  "password",
  "deviceId",
  "deviceName",
] as const;

export type MatrixResolvedStringField = (typeof MATRIX_CONFIG_STRING_FIELDS)[number];

export type MatrixResolvedStringValues = Record<MatrixResolvedStringField, string>;

type MatrixStringSourceMap = Partial<Record<MatrixResolvedStringField, string>>;

const MATRIX_DEFAULT_ACCOUNT_AUTH_ONLY_FIELDS = new Set<MatrixResolvedStringField>([
  "userId",
  "accessToken",
  "password",
  "deviceId",
]);

function resolveMatrixStringSourceValue(value: string | undefined): string {
  return typeof value === "string" ? value : "";
}

export function resolveMatrixAccountStringValues(params: {
  accountId: string;
  account?: MatrixStringSourceMap;
  scopedEnv?: MatrixStringSourceMap;
  channel?: MatrixStringSourceMap;
  globalEnv?: MatrixStringSourceMap;
}): MatrixResolvedStringValues {
  const resolved = {} as MatrixResolvedStringValues;
  const isDefaultAccount = normalizeAccountId(params.accountId) === DEFAULT_ACCOUNT_ID;

  for (const field of MATRIX_CONFIG_STRING_FIELDS) {
    resolved[field] =
      resolveMatrixStringSourceValue(params.account?.[field]) ||
      resolveMatrixStringSourceValue(params.scopedEnv?.[field]) ||
      (isDefaultAccount || !MATRIX_DEFAULT_ACCOUNT_AUTH_ONLY_FIELDS.has(field)
        ? resolveMatrixStringSourceValue(params.channel?.[field]) ||
          resolveMatrixStringSourceValue(params.globalEnv?.[field])
        : "");
  }

  return resolved;
}
