const DEFAULT_GATEWAY = "https://desktop-kuuq6fp.tailc4dc52.ts.net";
const DEFAULT_TOKEN = "d8d08cc19ca3fae045ad74fad14daf51cb627b1842b5e985";
const statusEl = document.getElementById("status");

function setStatus(kind, message) {
  if (!statusEl) return;
  statusEl.dataset.kind = kind || "";
  statusEl.textContent = message || "";
}

async function checkConnection(gatewayUrl) {
  setStatus("checking", "Checking gateway...");
  try {
    const res = await fetch(gatewayUrl + "/", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      setStatus("ok", "Gateway reachable. Open side panel to chat.");
    } else {
      setStatus("error", "Gateway returned HTTP " + res.status);
    }
  } catch {
    setStatus("error", "Cannot reach " + gatewayUrl);
  }
}

async function load() {
  const stored = await chrome.storage.local.get(["gatewayUrl", "gatewayToken"]);
  document.getElementById("gateway-url").value = stored.gatewayUrl || DEFAULT_GATEWAY;
  document.getElementById("token").value = stored.gatewayToken || DEFAULT_TOKEN;
  if (stored.gatewayUrl) {
    await checkConnection(stored.gatewayUrl);
  }
}

async function save() {
  const gatewayUrl = document.getElementById("gateway-url").value.trim() || DEFAULT_GATEWAY;
  const token = document.getElementById("token").value.trim();

  if (!token) {
    setStatus("error", "Token is required. Find it in openclaw.json under gateway.auth.token");
    return;
  }

  await chrome.storage.local.set({ gatewayUrl, gatewayToken: token, autoAttach: true });
  document.getElementById("gateway-url").value = gatewayUrl;
  await checkConnection(gatewayUrl);
}

document.getElementById("save").addEventListener("click", () => void save());
void load();
