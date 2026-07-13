// Popup: pairing, connection status, and per-tab share toggle.

const statusDot = document.getElementById("statusDot");
const pairSection = document.getElementById("pairSection");
const connectedSection = document.getElementById("connectedSection");
const pairingInput = document.getElementById("pairingString");
const pairButton = document.getElementById("pairButton");
const unpairButton = document.getElementById("unpairButton");
const shareButton = document.getElementById("shareButton");
const statusLine = document.getElementById("statusLine");
const errorLine = document.getElementById("error");

const STATE_LABEL = {
  on: "Connected to OpenClaw",
  connecting: "Connecting…",
  error: "Relay unreachable — is the OpenClaw gateway running?",
  off: "Not connected",
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "getStatus" });
  statusDot.className = `dot ${status.state}`;
  pairSection.classList.toggle("hidden", status.paired);
  connectedSection.classList.toggle("hidden", !status.paired);
  if (!status.paired) {
    return;
  }
  const label = STATE_LABEL[status.state] ?? STATE_LABEL.off;
  statusLine.textContent = `${label} · ${status.sharedTabCount} tab${status.sharedTabCount === 1 ? "" : "s"} shared`;
  const tab = await activeTab();
  if (tab?.id === undefined) {
    shareButton.classList.add("hidden");
    return;
  }
  const { shared } = await chrome.runtime.sendMessage({ type: "isTabShared", tabId: tab.id });
  shareButton.classList.remove("hidden");
  shareButton.textContent = shared ? "Stop sharing this tab" : "Share this tab with OpenClaw";
  shareButton.dataset.tabId = String(tab.id);
}

async function onPair() {
  errorLine.classList.add("hidden");
  const result = await chrome.runtime.sendMessage({
    type: "pair",
    pairingString: pairingInput.value,
  });
  if (!result.ok) {
    errorLine.textContent = result.error ?? "Pairing failed.";
    errorLine.classList.remove("hidden");
    return;
  }
  await refresh();
}

async function onUnpair() {
  await chrome.runtime.sendMessage({ type: "unpair" });
  await refresh();
}

async function onToggleShare() {
  const tabId = Number.parseInt(shareButton.dataset.tabId ?? "", 10);
  if (Number.isFinite(tabId)) {
    await chrome.runtime.sendMessage({ type: "toggleShareTab", tabId });
  }
  await refresh();
}

pairButton.addEventListener("click", () => void onPair());
unpairButton.addEventListener("click", () => void onUnpair());
shareButton.addEventListener("click", () => void onToggleShare());

void refresh();
setInterval(() => void refresh(), 2000);
