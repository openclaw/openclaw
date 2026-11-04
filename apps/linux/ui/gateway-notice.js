function isPackagedShellPage(pageUrl) {
  const localOrigin =
    (pageUrl.protocol === "tauri:" && pageUrl.hostname === "localhost" && pageUrl.port === "" &&
      pageUrl.username === "" && pageUrl.password === "") ||
    ((pageUrl.origin === "http://tauri.localhost" || pageUrl.origin === "https://tauri.localhost") &&
      pageUrl.username === "" && pageUrl.password === "");
  return localOrigin && ["/", "/index.html", "/gateways.html"].includes(pageUrl.pathname);
}

function installGatewayNotice(config) {
  if (window !== window.top || window.__OPENCLAW_GATEWAY_NOTICE_INSTALLED__) return;
  if (!config) {
    return;
  }
  const pageUrl = new URL(location.href);
  const localShell = isPackagedShellPage(pageUrl);
  const shellHost = pageUrl.protocol === "tauri:" || pageUrl.hostname === "tauri.localhost";
  const base = config.base?.replace(/\/$/u, "") ?? "";
  const configuredPage =
    Boolean(config.origin) && pageUrl.username === "" && pageUrl.password === "" &&
    pageUrl.origin === config.origin &&
    (!base || pageUrl.pathname === base || pageUrl.pathname.startsWith(base + "/"));
  if (shellHost && !localShell && !configuredPage) {
    return;
  }
  if (localShell ? pageUrl.origin !== config.origin || config.base !== "" : !configuredPage) {
    return;
  }
  window.__OPENCLAW_GATEWAY_NOTICE_INSTALLED__ = true;

  let message;
  let notice;
  let text;
  const clear = () => {
    message = undefined;
    if (notice) notice.hidden = true;
  };
  const render = () => {
    if (message === undefined || !document.body) return;
    if (!notice) {
      notice = document.createElement("div");
      notice.setAttribute("role", "alert");
      notice.setAttribute("aria-atomic", "true");
      // Injected dashboards can predate the companion's shared chrome styles.
      notice.style.cssText = "position:fixed;top:56px;right:12px;z-index:10000;max-width:min(360px,90vw);box-sizing:border-box;padding:12px 44px 12px 12px;border:1px solid currentColor;border-radius:8px;background:var(--bg,#0e1015);color:var(--text,#f6f7fb);font:13px/1.5 var(--font-body,system-ui,sans-serif);overflow-wrap:anywhere";
      text = document.createElement("span");
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.setAttribute("aria-label", config.chrome?.dismissGatewayNotice || "Dismiss Gateway notice");
      dismiss.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="display:block;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="m6 6 12 12M6 18 18 6"/></svg>';
      dismiss.style.cssText = "position:absolute;top:6px;right:6px;width:28px;height:28px;min-width:0;padding:0;border:0;background:transparent;color:inherit;display:flex;align-items:center;justify-content:center;cursor:pointer";
      dismiss.addEventListener("click", clear);
      notice.append(text, dismiss);
      document.body.append(notice);
    }
    if (text.textContent !== message) text.textContent = message;
    notice.hidden = false;
  };
  window.addEventListener("openclaw:gateway-notice", (event) => {
    const next = event.detail?.message;
    if (typeof next !== "string" || !next.trim()) return;
    message = next;
    render();
  });
  window.addEventListener("openclaw:gateway-notice-clear", clear);
  document.addEventListener("DOMContentLoaded", render, { once: true });
}

const pageUrl = new URL(location.href);
if (isPackagedShellPage(pageUrl)) {
  installGatewayNotice({
    origin: pageUrl.origin,
    base: "",
    chrome: window["__OPENCLAW_TAURI_CHROME__"] ?? {},
  });
}
