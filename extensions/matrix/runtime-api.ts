// Keep the external runtime API light so Jiti callers can resolve Matrix config
// helpers without traversing the full plugin-sdk/runtime graph.
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
