(() => {
  if (window !== window.top || window.__OPENCLAW_GATEWAY_NOTICE_INSTALLED__) return;
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
      dismiss.setAttribute("aria-label", "Dismiss Gateway notice");
      dismiss.textContent = "×";
      dismiss.style.cssText = "position:absolute;top:6px;right:6px;width:28px;height:28px;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:20px/1 system-ui,sans-serif;cursor:pointer";
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
})();
