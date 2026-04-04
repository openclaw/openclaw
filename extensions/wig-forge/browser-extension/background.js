const ext = globalThis.browser ?? globalThis.chrome;
const DEFAULTS = {
  gatewayBaseUrl: "http://127.0.0.1:18789",
  inventoryKey: "default-web",
};

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "wig-forge:capture-visible-tab") {
    return undefined;
  }

  const tab = sender?.tab;
  if (!tab?.windowId) {
    sendResponse({ ok: false, error: "No active tab window found." });
    return undefined;
  }

  Promise.resolve()
    .then(() => ext.tabs.captureVisibleTab(tab.windowId, { format: "png" }))
    .then((dataUrl) => {
      sendResponse({ ok: true, dataUrl });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

ext.commands?.onCommand.addListener((command) => {
  if (command !== "start-capture") {
    return;
  }

  advanceCaptureOnActiveTab().catch((error) => {
    console.error("[wig-forge] failed to start capture from command", error);
  });
});

async function advanceCaptureOnActiveTab() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  const stored = await ext.storage.local.get(DEFAULTS);
  const gatewayBaseUrl = normalizeGatewayBaseUrl(stored.gatewayBaseUrl || DEFAULTS.gatewayBaseUrl);
  const inventoryKey =
    String(stored.inventoryKey || DEFAULTS.inventoryKey).trim() || DEFAULTS.inventoryKey;

  await ext.tabs.sendMessage(tab.id, {
    type: "wig-forge:advance-capture",
    gatewayBaseUrl,
    inventoryKey,
  });
}

function normalizeGatewayBaseUrl(value) {
  const url = new URL(value || DEFAULTS.gatewayBaseUrl);
  return url.origin;
}
