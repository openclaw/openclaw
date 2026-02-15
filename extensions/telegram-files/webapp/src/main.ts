import type { TelegramWebApp } from "./services/telegram.js";
import { mountApp } from "./app.js";
import { restoreToken, saveToken, clearToken, exchangePairCode } from "./services/auth.js";
import { FilesApiClient } from "./services/files-api.js";
import { getTelegramWebApp } from "./services/telegram.js";
import { errorMessage } from "./utils.js";

async function main() {
  const app = document.getElementById("app");
  if (!app) {
    document.body.textContent = "Fatal: #app element not found";
    return;
  }
  const webapp = getTelegramWebApp();

  webapp.ready();
  webapp.expand();

  showStatus(app, "Connecting...");

  try {
    const token = await authenticate();
    const client = new FilesApiClient(token);

    // Strip pair code from URL after successful auth
    const url = new URL(window.location.href);
    if (url.searchParams.has("pair")) {
      url.searchParams.delete("pair");
      history.replaceState(null, "", url.toString());
    }

    app.replaceChildren();
    mountApp(app, client);
  } catch (err) {
    const msg = errorMessage(err);
    if (isAuthError(msg)) {
      // Clear stale token so next open doesn't repeat
      try {
        await clearToken();
      } catch {
        /* ignore */
      }
      showExpiredUI(app, webapp);
    } else {
      showStatus(app, `Connection failed: ${msg}`, true);
    }
  }
}

function isAuthError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("unauthorized") ||
    lower.includes("expired") ||
    lower.includes("no saved token") ||
    lower.includes("invalid") ||
    lower.includes("pairing")
  );
}

async function authenticate(): Promise<string> {
  // 1. Check URL for pairing code FIRST (fresh code takes priority)
  const url = new URL(window.location.href);
  const pairCode = url.searchParams.get("pair");

  if (pairCode) {
    try {
      const token = await exchangePairCode(pairCode);

      // Save (best-effort)
      try {
        await saveToken(token);
      } catch {
        /* CloudStorage unavailable */
      }

      // Validate the fresh token actually works
      const client = new FilesApiClient(token);
      await client.home();

      return token;
    } catch {
      // Pairing code already used or expired — fall through to saved token
    }
  }

  // 2. Try saved token
  try {
    const saved = await restoreToken();
    if (saved && saved.length > 0) {
      // Validate token is still active on server
      const client = new FilesApiClient(saved);
      await client.home();
      return saved;
    }
  } catch {
    // Token invalid or CloudStorage unavailable — clear and continue
    try {
      await clearToken();
    } catch {
      /* ignore */
    }
  }

  throw new Error("No saved token. Send /files in Telegram to get started.");
}

/** Show a friendly UI when the session has expired. */
function showExpiredUI(container: HTMLElement, webapp: TelegramWebApp) {
  container.replaceChildren();

  const wrapper = document.createElement("div");
  wrapper.className = "status-message";

  const icon = document.createElement("div");
  icon.style.fontSize = "48px";
  icon.style.marginBottom = "12px";
  icon.textContent = "\u{1F511}";

  const title = document.createElement("div");
  title.style.fontWeight = "600";
  title.style.fontSize = "16px";
  title.style.marginBottom = "8px";
  title.textContent = "Session Expired";

  const desc = document.createElement("div");
  desc.style.marginBottom = "16px";
  desc.textContent = "Send /files in Telegram to get a new link.";

  const closeBtn = document.createElement("button");
  closeBtn.style.cssText =
    "padding:10px 24px;border-radius:8px;border:none;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);font-size:14px;font-weight:600;cursor:pointer;";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => webapp.close());

  wrapper.appendChild(icon);
  wrapper.appendChild(title);
  wrapper.appendChild(desc);
  wrapper.appendChild(closeBtn);
  container.appendChild(wrapper);
}

function showStatus(container: HTMLElement, message: string, isError = false) {
  container.replaceChildren();
  const div = document.createElement("div");
  div.className = `status-message ${isError ? "error-text" : ""}`;
  div.textContent = message;
  container.appendChild(div);
}

main();
