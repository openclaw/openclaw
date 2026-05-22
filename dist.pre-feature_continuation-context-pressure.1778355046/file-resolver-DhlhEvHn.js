import { r as lowercasePreservingWhitespace } from "./string-coerce-Bje8XVt9.js";
import { s as openFileWithinRoot, t as SafeOpenError } from "./fs-safe-EW2E3K3c.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/canvas-host/a2ui-shared.ts
const A2UI_PATH = "/__openclaw__/a2ui";
const CANVAS_HOST_PATH = "/__openclaw__/canvas";
const CANVAS_WS_PATH = "/__openclaw__/ws";
function isA2uiPath(pathname) {
	return pathname === "/__openclaw__/a2ui" || pathname.startsWith(`/__openclaw__/a2ui/`);
}
function injectCanvasLiveReload(html) {
	const snippet = `
<script>
(() => {
  // Cross-platform action bridge helper.
  // Works on:
  // - iOS: window.webkit.messageHandlers.openclawCanvasA2UIAction.postMessage(...)
  // - Android: window.openclawCanvasA2UIAction.postMessage(...)
  const handlerNames = ["openclawCanvasA2UIAction"];
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
  } catch {}
})();
<\/script>
`.trim();
	const idx = lowercasePreservingWhitespace(html).lastIndexOf("</body>");
	if (idx >= 0) return `${html.slice(0, idx)}\n${snippet}\n${html.slice(idx)}`;
	return `${html}\n${snippet}\n`;
}
//#endregion
//#region src/canvas-host/file-resolver.ts
function normalizeUrlPath(rawPath) {
	const decoded = decodeURIComponent(rawPath || "/");
	const normalized = path.posix.normalize(decoded);
	return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
async function resolveFileWithinRoot(rootReal, urlPath) {
	const normalized = normalizeUrlPath(urlPath);
	const rel = normalized.replace(/^\/+/, "");
	if (rel.split("/").some((p) => p === "..")) return null;
	const tryOpen = async (relative) => {
		try {
			return await openFileWithinRoot({
				rootDir: rootReal,
				relativePath: relative
			});
		} catch (err) {
			if (err instanceof SafeOpenError) return null;
			throw err;
		}
	};
	if (normalized.endsWith("/")) return await tryOpen(path.posix.join(rel, "index.html"));
	const candidate = path.join(rootReal, rel);
	try {
		const st = await fs.lstat(candidate);
		if (st.isSymbolicLink()) return null;
		if (st.isDirectory()) return await tryOpen(path.posix.join(rel, "index.html"));
	} catch {}
	return await tryOpen(rel);
}
//#endregion
export { CANVAS_WS_PATH as a, CANVAS_HOST_PATH as i, resolveFileWithinRoot as n, injectCanvasLiveReload as o, A2UI_PATH as r, isA2uiPath as s, normalizeUrlPath as t };
