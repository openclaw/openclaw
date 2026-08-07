// Extension configuration read from chrome.storage: the relay pairing (url/token,
// tab-group color) and the copilot gateway url. Kept in one place so the service
// worker and the tab-group helpers share a single source of truth.

export async function getConfig() {
  const stored = await chrome.storage.local.get(["relayUrl", "token", "groupColor"]);
  return {
    relayUrl: typeof stored.relayUrl === "string" ? stored.relayUrl : "",
    token: typeof stored.token === "string" ? stored.token : "",
    groupColor: typeof stored.groupColor === "string" ? stored.groupColor : "orange",
  };
}

export async function getCopilotConfig() {
  const config = await getConfig();
  const stored = await chrome.storage.local.get(["gatewayUrl"]);
  return {
    ...config,
    gatewayUrl: typeof stored.gatewayUrl === "string" ? stored.gatewayUrl : "",
  };
}
