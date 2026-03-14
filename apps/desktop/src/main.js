const GATEWAY_URL = "http://localhost:18789";
const POLL_INTERVAL_MS = 2000;

const statusEl = document.getElementById("status");

async function checkGateway() {
  try {
    const res = await fetch(
      `${GATEWAY_URL}/__openclaw/control-ui-config.json`,
      { signal: AbortSignal.timeout(2000) }
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function init() {
  const connected = await checkGateway();
  if (connected) {
    window.location.href = GATEWAY_URL;
    return;
  }

  statusEl.textContent = "Waiting for gateway at localhost:18789...";

  // Poll until gateway comes online
  const interval = setInterval(async () => {
    const up = await checkGateway();
    if (up) {
      clearInterval(interval);
      statusEl.textContent = "Connected! Loading...";
      window.location.href = GATEWAY_URL;
    }
  }, POLL_INTERVAL_MS);
}

// Also listen for Tauri events if available (when on the splash page)
try {
  if (window.__TAURI__) {
    const { listen } = window.__TAURI__.event;
    listen("gateway-status-changed", (event) => {
      if (event.payload === true) {
        window.location.href = GATEWAY_URL;
      }
    });
  }
} catch {
  // Tauri API not available, using fetch polling instead
}

void init();
