const ext = globalThis.browser ?? globalThis.chrome;

const gatewayInput = document.querySelector("#gateway-url");
const inventoryKeyInput = document.querySelector("#inventory-key");
const statusNode = document.querySelector("#status");
const startButton = document.querySelector("#start-button");
const roomButton = document.querySelector("#room-button");

const DEFAULTS = {
  gatewayBaseUrl: "http://127.0.0.1:18789",
  inventoryKey: "default-web",
};

init().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), true);
});

async function init() {
  const stored = await ext.storage.local.get(DEFAULTS);
  gatewayInput.value = stored.gatewayBaseUrl || DEFAULTS.gatewayBaseUrl;
  inventoryKeyInput.value = stored.inventoryKey || DEFAULTS.inventoryKey;

  const persistSettings = async () => {
    const gatewayBaseUrl = normalizeGatewayBaseUrl(gatewayInput.value);
    const inventoryKey =
      (inventoryKeyInput.value || DEFAULTS.inventoryKey).trim() || DEFAULTS.inventoryKey;
    await ext.storage.local.set({ gatewayBaseUrl, inventoryKey });
    return { gatewayBaseUrl, inventoryKey };
  };

  startButton.addEventListener("click", async () => {
    try {
      const { gatewayBaseUrl, inventoryKey } = await persistSettings();

      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        throw new Error("No active tab found.");
      }
      await ext.tabs.sendMessage(tab.id, {
        type: "wig-forge:start-selection",
        gatewayBaseUrl,
        inventoryKey,
      });
      setStatus("Selection mode enabled. Click a visible element on the page.");
      window.close();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });

  roomButton.addEventListener("click", async () => {
    try {
      const { gatewayBaseUrl, inventoryKey } = await persistSettings();
      await ext.tabs.create({
        url: buildRoomUrl(gatewayBaseUrl, inventoryKey),
      });
      setStatus("Opened the collection room in a new tab.");
      window.close();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });

  inventoryKeyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      startButton.click();
    }
  });
}

function normalizeGatewayBaseUrl(value) {
  const url = new URL(value || DEFAULTS.gatewayBaseUrl);
  return url.origin;
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.style.color = isError ? "#9e284f" : "rgba(32, 25, 19, 0.66)";
}

function buildRoomUrl(gatewayBaseUrl, inventoryKey) {
  const url = new URL("/plugins/wig-forge/room", gatewayBaseUrl);
  url.searchParams.set("inventoryKey", inventoryKey);
  return url.toString();
}
