const DEFAULT_GATEWAY = "http://127.0.0.1:18789";
const DEFAULT_TOKEN = "";
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

  // Loopback gateways may run with auth disabled (gateway.auth.mode "none"), and
  // the relay/side panel now support tokenless loopback; allow saving a tokenless
  // setup there. Remote gateways still require a token.
  const isLoopback = /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(gatewayUrl);
  if (!token && !isLoopback) {
    setStatus("error", "A gateway token or password is required for remote gateways. Find it in openclaw.json under gateway.auth.token (or gateway.auth.password).");
    return;
  }

  await chrome.storage.local.set({ gatewayUrl, gatewayToken: token, autoAttach: true });
  document.getElementById("gateway-url").value = gatewayUrl;
  await checkConnection(gatewayUrl);
}

document.getElementById("save").addEventListener("click", () => void save());
void load();
