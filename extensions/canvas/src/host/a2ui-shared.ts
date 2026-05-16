import { lowercasePreservingWhitespace } from "openclaw/plugin-sdk/string-coerce-runtime";

export const A2UI_PATH = "/__openclaw__/a2ui";

export const CANVAS_HOST_PATH = "/__openclaw__/canvas";

export const CANVAS_WS_PATH = "/__openclaw__/ws";

export function isA2uiPath(pathname: string): boolean {
  return pathname === A2UI_PATH || pathname.startsWith(`${A2UI_PATH}/`);
}

export function injectCanvasLiveReload(html: string): string {
  const snippet = `
<script>
(() => {
  const CANVAS_LIVE_RELOAD_ERROR_EVENT = "openclaw:canvas-live-reload-error";

  // Cross-platform action bridge helper.
  // Works on:
  // - iOS: window.webkit.messageHandlers.openclawCanvasA2UIAction.postMessage(...)
  // - Android: window.openclawCanvasA2UIAction.postMessage(...)
  const handlerNames = ["openclawCanvasA2UIAction"];
  let liveReloadErrorReported = false;
  function describeError(err) {
    if (
      err &&
      typeof err === "object" &&
      "message" in err &&
      typeof err.message === "string" &&
      err.message
    ) {
      return err.message;
    }
    if (err && typeof err === "object") {
      const parts = ["WebSocket connection failed"];
      if ("code" in err && err.code) parts.push("code=" + String(err.code));
      if ("reason" in err && err.reason) parts.push(String(err.reason));
      return parts.join(": ");
    }
    return String(err);
  }
  function reportCanvasLiveReloadError(err) {
    if (liveReloadErrorReported) return;
    liveReloadErrorReported = true;
    const message = describeError(err);
    try {
      console.error("OpenClaw canvas live reload unavailable:", err);
    } catch {}
    try {
      document.documentElement?.setAttribute("data-openclaw-live-reload", "error");
      document.documentElement?.setAttribute("data-openclaw-live-reload-error", message);
    } catch {}
    try {
      globalThis.dispatchEvent?.(
        new CustomEvent(CANVAS_LIVE_RELOAD_ERROR_EVENT, {
          detail: { message },
        }),
      );
    } catch {}
  }
  function postToNode(payload) {
    try {
      const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
      for (const name of handlerNames) {
        const iosHandler = globalThis.webkit?.messageHandlers?.[name];
        if (iosHandler && typeof iosHandler.postMessage === "function") {
          iosHandler.postMessage(raw);
          return true;
        }
        const androidHandler = globalThis[name];
        if (androidHandler && typeof androidHandler.postMessage === "function") {
          // Important: call as a method on the interface object (binding matters on Android WebView).
          androidHandler.postMessage(raw);
          return true;
        }
      }
    } catch {}
    return false;
  }
  function sendUserAction(userAction) {
    const id =
      (userAction && typeof userAction.id === "string" && userAction.id.trim()) ||
      (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
    const action = { ...userAction, id };
    return postToNode({ userAction: action });
  }
  globalThis.OpenClaw = globalThis.OpenClaw ?? {};
  globalThis.OpenClaw.postMessage = postToNode;
  globalThis.OpenClaw.sendUserAction = sendUserAction;
  globalThis.openclawPostMessage = postToNode;
  globalThis.openclawSendUserAction = sendUserAction;

  try {
    const cap = new URLSearchParams(location.search).get("oc_cap");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const capQuery = cap ? "?oc_cap=" + encodeURIComponent(cap) : "";
    const ws = new WebSocket(proto + "://" + location.host + ${JSON.stringify(CANVAS_WS_PATH)} + capQuery);
    ws.onmessage = (ev) => {
      if (String(ev.data || "") === "reload") location.reload();
    };
    ws.onerror = (ev) => {
      reportCanvasLiveReloadError(ev);
    };
    ws.onclose = (ev) => {
      reportCanvasLiveReloadError(ev);
    };
  } catch (err) {
    reportCanvasLiveReloadError(err);
  }
})();
</script>
`.trim();

  const idx = lowercasePreservingWhitespace(html).lastIndexOf("</body>");
  if (idx >= 0) {
    return `${html.slice(0, idx)}\n${snippet}\n${html.slice(idx)}`;
  }
  return `${html}\n${snippet}\n`;
}
