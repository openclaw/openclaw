import {
  fetchPanels,
  fetchGuide,
  fetchPromptBarConfig,
  fetchWalkthrough,
  startTheDay,
  getToken,
  setToken,
  type PanelData,
  type PanelHelpInfo,
} from "./api";
import { wireInfoIcons } from "./components/info-icon";
import { createPromptBar } from "./components/prompt-bar";
import { hasCompletedWalkthrough, startWalkthrough } from "./components/walkthrough";
import { createLayout } from "./layout";
import { logEvent, exposeOnWindow } from "./logger";
import { renderApprovalsPanel } from "./panels/approvals";
import { renderHealthPanel } from "./panels/health";
import { renderKpiChipsPanel } from "./panels/kpi-chips";
import { renderSchedulePanel } from "./panels/schedule";
import { renderTodayPanel } from "./panels/today";

const REFRESH_INTERVAL = 30_000; // 30 seconds

let guideData: Record<string, PanelHelpInfo> = {};
let isRefreshing = false;

async function boot() {
  const app = document.getElementById("app");
  if (!app) {
    return;
  }

  // Expose event log on window for debugging
  exposeOnWindow();
  logEvent("boot", "Command Center starting");

  // Check for token — prompt if missing
  if (!getToken()) {
    const token = prompt("Enter your Admin Token (X-Admin-Token):");
    if (token) {
      setToken(token);
      logEvent("auth", "Token set by user");
    } else {
      logEvent("auth", "No token provided — dashboard will show auth errors");
    }
  }

  // Build layout
  const layout = createLayout();
  app.appendChild(layout);

  // Show loading skeletons in all panel mounts
  showLoadingPanels();

  // Load prompt bar config and mount it
  try {
    const pbConfig = await fetchPromptBarConfig();
    const promptBar = createPromptBar(pbConfig);
    document.getElementById("prompt-bar-mount")?.appendChild(promptBar);
  } catch {
    // Fallback prompt bar with defaults
    const promptBar = createPromptBar({
      placeholder: "Ask OpenClaw anything...",
      suggestions: [
        "What should I focus on today?",
        "Run the start of day routine.",
        "Check website health.",
        "What needs my approval?",
      ],
      help_text: "Type any question or request in plain English.",
    });
    document.getElementById("prompt-bar-mount")?.appendChild(promptBar);
  }

  // Load guide data for info icons
  try {
    guideData = await fetchGuide();
  } catch {
    guideData = {};
  }

  // Initial panel load
  await refreshPanels();

  // Auto-refresh
  setInterval(refreshPanels, REFRESH_INTERVAL);

  // Tour button
  document.getElementById("tour-btn")?.addEventListener("click", async () => {
    logEvent("walkthrough", "Tour button clicked");
    try {
      const steps = await fetchWalkthrough();
      startWalkthrough(steps);
    } catch {
      startWalkthrough([
        {
          title: "Welcome to OpenClaw",
          body: "This is your operating system for Full Digital and CUTMV. You can talk to it in plain English to get things done.",
          spotlight: null,
          tip: 'Try typing: "What should I focus on today?"',
          cta: "Got it",
        },
      ]);
    }
  });

  // Auto-start walkthrough on first visit
  if (!hasCompletedWalkthrough()) {
    try {
      const steps = await fetchWalkthrough();
      if (steps.length > 0) {
        logEvent("walkthrough", "Auto-started on first visit");
        startWalkthrough(steps);
      }
    } catch {
      // Silent — don't block first load
    }
  }

  // Manual refresh button
  document.getElementById("refresh-btn")?.addEventListener("click", () => {
    logEvent("refresh", "Manual refresh triggered");
    void refreshPanels();
  });

  // Token status
  updateTokenStatus();
  updateConnectionIndicator("connected");

  logEvent("boot", "Command Center ready");
}

function showLoadingPanels() {
  const panelIds = [
    "panel-today",
    "panel-schedule",
    "panel-kpi",
    "panel-health",
    "panel-approvals",
  ];
  for (const id of panelIds) {
    const mount = document.getElementById(id);
    if (mount) {
      mount.innerHTML = `<div class="panel panel-loading"><div class="loading-skeleton"></div><div class="loading-skeleton loading-skeleton-short"></div></div>`;
    }
  }
}

async function refreshPanels() {
  if (isRefreshing) {
    return;
  }
  isRefreshing = true;

  // Show spinner on refresh button
  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.classList.add("spinning");
  }

  try {
    const data: PanelData = await fetchPanels();

    // Render panels
    mountPanel("panel-today", renderTodayPanel(data.today));
    mountPanel("panel-schedule", renderSchedulePanel(data.schedule, data.today));
    mountPanel("panel-kpi", renderKpiChipsPanel(data.today));
    mountPanel("panel-health", renderHealthPanel(data.health));
    mountPanel("panel-approvals", renderApprovalsPanel(data.approvals));

    // Wire info icons
    wireInfoIcons(guideData);

    // Wire "Start the Day" button
    wireStartDay();

    // Update timestamp
    const refreshEl = document.getElementById("last-refresh");
    if (refreshEl) {
      refreshEl.textContent = new Date(data.ts).toLocaleTimeString();
    }

    updateConnectionIndicator("connected");
  } catch (err) {
    console.error("Failed to refresh panels:", err);
    logEvent("refresh_error", err instanceof Error ? err.message : "Unknown error");

    const refreshEl = document.getElementById("last-refresh");
    if (refreshEl) {
      refreshEl.textContent = `Error: ${err instanceof Error ? err.message : "Unknown"}`;
    }

    // Check if it's an auth error
    if (err instanceof Error && err.message.includes("401")) {
      updateConnectionIndicator("auth_error");
    } else {
      updateConnectionIndicator("disconnected");
    }
  } finally {
    isRefreshing = false;
    if (refreshBtn) {
      refreshBtn.classList.remove("spinning");
    }
  }
}

function mountPanel(id: string, el: HTMLElement) {
  const mount = document.getElementById(id);
  if (mount) {
    mount.innerHTML = "";
    mount.appendChild(el);
  }
}

function wireStartDay() {
  const btn = document.getElementById("start-day-btn");
  const status = document.getElementById("start-day-status");
  if (!btn || !status) {
    return;
  }

  btn.addEventListener("click", async () => {
    logEvent("start_day", "Start the Day clicked");
    (btn as HTMLButtonElement).disabled = true;
    btn.textContent = "Syncing...";
    status.textContent = "Running schedule sync + refresh...";

    try {
      const result = await startTheDay();
      if ((result as Record<string, boolean>).skipped) {
        status.textContent = "Skipped (cooldown active)";
        showToast("Skipped: cooldown active", "warn");
        logEvent("start_day", "Skipped — cooldown active");
      } else if ((result as Record<string, boolean>).ok) {
        status.textContent = "Done!";
        showToast("Day started! Schedule synced.", "ok");
        logEvent("start_day", "Completed successfully");
        // Refresh panels after sync
        setTimeout(refreshPanels, 1000);
      } else {
        status.textContent = "Error";
        showToast("Start day failed", "bad");
        logEvent("start_day", "Failed — unknown error");
      }
    } catch (err) {
      status.textContent = `Error: ${err instanceof Error ? err.message : "Unknown"}`;
      showToast("Network error", "bad");
      logEvent("start_day", `Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      (btn as HTMLButtonElement).disabled = false;
      btn.textContent = "Start the Day";
    }
  });
}

function showToast(msg: string, kind: "ok" | "warn" | "bad") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.textContent = msg;
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add("toast-fade"), 3000);
  setTimeout(() => toast.remove(), 3500);
}

function updateTokenStatus() {
  const el = document.getElementById("token-status");
  if (el) {
    el.textContent = getToken() ? "Token set" : "No token";
    el.style.color = getToken() ? "var(--accent-green)" : "var(--accent-red)";
  }
}

function updateConnectionIndicator(state: "connected" | "disconnected" | "auth_error") {
  const dot = document.getElementById("conn-dot");
  const label = document.getElementById("conn-label");
  if (!dot || !label) {
    return;
  }

  switch (state) {
    case "connected":
      dot.style.background = "var(--accent-green)";
      label.textContent = "Connected";
      label.style.color = "var(--accent-green)";
      break;
    case "disconnected":
      dot.style.background = "var(--accent-red)";
      label.textContent = "Disconnected";
      label.style.color = "var(--accent-red)";
      break;
    case "auth_error":
      dot.style.background = "var(--accent-yellow)";
      label.textContent = "Auth Error";
      label.style.color = "var(--accent-yellow)";
      break;
  }
}

// Boot
void boot();
