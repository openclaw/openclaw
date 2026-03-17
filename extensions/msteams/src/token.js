import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString
} from "./secret-input.js";
function hasConfiguredMSTeamsCredentials(cfg) {
  return Boolean(
    normalizeSecretInputString(cfg?.appId) && hasConfiguredSecretInput(cfg?.appPassword) && normalizeSecretInputString(cfg?.tenantId)
  );
}
function resolveMSTeamsCredentials(cfg) {
  const appId = normalizeSecretInputString(cfg?.appId) || normalizeSecretInputString(process.env.MSTEAMS_APP_ID);
  const appPassword = normalizeResolvedSecretInputString({
    value: cfg?.appPassword,
    path: "channels.msteams.appPassword"
  }) || normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD);
  const tenantId = normalizeSecretInputString(cfg?.tenantId) || normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID);
  if (!appId || !appPassword || !tenantId) {
    return void 0;
  }
  return { appId, appPassword, tenantId };
}
export {
  hasConfiguredMSTeamsCredentials,
  resolveMSTeamsCredentials
};
