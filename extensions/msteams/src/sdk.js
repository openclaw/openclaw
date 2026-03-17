async function loadMSTeamsSdk() {
  return await import("@microsoft/agents-hosting");
}
function buildMSTeamsAuthConfig(creds, sdk) {
  return sdk.getAuthConfigWithDefaults({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId
  });
}
function createMSTeamsAdapter(authConfig, sdk) {
  return new sdk.CloudAdapter(authConfig);
}
async function loadMSTeamsSdkWithAuth(creds) {
  const sdk = await loadMSTeamsSdk();
  const authConfig = buildMSTeamsAuthConfig(creds, sdk);
  return { sdk, authConfig };
}
export {
  buildMSTeamsAuthConfig,
  createMSTeamsAdapter,
  loadMSTeamsSdk,
  loadMSTeamsSdkWithAuth
};
