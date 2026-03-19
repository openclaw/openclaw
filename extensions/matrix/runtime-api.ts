export * from "openclaw/plugin-sdk/matrix";
export * from "./src/auth-precedence.js";
export {
  findMatrixAccountEntry,
  hashMatrixAccessToken,
  listMatrixEnvAccountIds,
  resolveConfiguredMatrixAccountIds,
  resolveMatrixChannelConfig,
  resolveMatrixCredentialsFilename,
  resolveMatrixEnvAccountToken,
  resolveMatrixHomeserverKey,
  resolveMatrixLegacyFlatStoreRoot,
  sanitizeMatrixPathSegment,
} from "./helper-api.js";
