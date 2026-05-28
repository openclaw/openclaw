import { AppRoot } from "@telegram-apps/telegram-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@telegram-apps/telegram-ui/dist/styles.css";
import "./index.css";
import App from "./App.tsx";

type TelegramWebAppBridge = {
  ready?: () => void;
  expand?: () => void;
  requestFullscreen?: () => void;
};

function initTelegramWebApp(): void {
  const bridge = (
    window as Window & {
      Telegram?: { WebApp?: TelegramWebAppBridge };
    }
  ).Telegram?.WebApp;

  try {
    bridge?.ready?.();
    bridge?.expand?.();
    bridge?.requestFullscreen?.();
  } catch {
    // 在非 Telegram 環境忽略初始化錯誤，保留本機開發可用性。
  }
}

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/superclaw/sw.js").catch(() => {
      // 不中斷主流程；離線能力失敗時維持主功能可用。
    });
  });
}

initTelegramWebApp();
registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppRoot>
      <BrowserRouter basename="/superclaw/">
        <App />
      </BrowserRouter>
    </AppRoot>
  </StrictMode>,
);
