(config) => {
  if (window !== window.top) return;
  if (config.origin && (location.origin !== config.origin ||
      (config.base && location.pathname !== config.base && !location.pathname.startsWith(config.base + "/")))) return;
  if (!config.origin && !(location.protocol === "tauri:" || location.hostname === "tauri.localhost")) return;

  const dashboard = Boolean(config.origin);
  const macos = config.platform === "macos";
  const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  let enabled = !dashboard;
  let installed = false;
  let controls;
  let maximize;
  let errorNotice;
  let ready = !config.waitForDashboard;
  let stateRequest = 0;
  let modalOpen = Boolean(document.openClawModalLayers?.size);
  let chromeUpdate = Promise.resolve();
  const applyState = (state) => {
    if (!enabled || !document.documentElement) return;
    document.documentElement.classList.toggle("openclaw-window-fullscreen", state.fullscreen);
    document.documentElement.classList.toggle("openclaw-window-unfocused", !state.focused);
    if (maximize) {
      const label = state.maximized ? "Restore window" : "Maximize window";
      maximize.title = label;
      maximize.setAttribute("aria-label", label);
      maximize.dataset.maximized = String(state.maximized);
    }
  };
  const request = async (action) => {
    if (action === "state" && (!enabled || !ready)) return;
    const version = action === "state" ? ++stateRequest : null;
    try {
      const state = action === "drag"
        ? await invoke("window_chrome_drag")
        : await invoke("window_chrome_request", { action });
      if (version !== null && version !== stateRequest) return;
      // Window events own completed transitions; a command can return while
      // the OS still reports the previous maximized state.
      if (action === "ready") applyState(state);
      if (state?.history) {
        window.__OPENCLAW_NATIVE_HISTORY__ = state.history;
        window.dispatchEvent(new CustomEvent("openclaw:native-history-state", { detail: state.history }));
      }
      if (controls && (action === "ready" || action === "native-frame")) controls.hidden = modalOpen;
      if (errorNotice) errorNotice.hidden = true;
    } catch (error) {
      if (errorNotice) {
        errorNotice.textContent = `Window action failed: ${String(error)}`;
        errorNotice.hidden = false;
      }
    }
  };
  const syncChrome = () => {
    chromeUpdate = chromeUpdate.then(() => request(!enabled || (modalOpen && !macos) ? "native-frame" : "ready"));
    return chromeUpdate;
  };
  window.addEventListener("openclaw:window-state", (event) => applyState(event.detail));
  window.addEventListener("openclaw:native-modal-state", (event) => {
    if (!enabled) return;
    modalOpen = event.detail.open;
    // HTML modal dialogs make body siblings inert, including caption buttons.
    // Keep real OS controls available until the last modal closes.
    void syncChrome();
  });
  window.addEventListener("openclaw:window-history-changed", () => void request("state"));
  window.addEventListener("openclaw:native-browser-ready", () => {
    ready = true;
    if (enabled) void syncChrome().then(() => request("state"));
  });
  // Keep the actual event through the shared UI's bubbling mousedown handler.
  // This preserves double-click zoom without changing the macOS bridge contract.
  let press;
  let pendingDrag;
  window.addEventListener("mousedown", (event) => {
    pendingDrag = undefined;
    press = event.isTrusted && event.button === 0 ? event : undefined;
    setTimeout(() => { press = undefined; }, 0);
  }, true);
  window.addEventListener("mouseup", () => { pendingDrag = undefined; }, true);
  window.addEventListener("blur", () => { pendingDrag = undefined; });
  window.addEventListener("mousemove", (event) => {
    if (!pendingDrag || !event.isTrusted) return;
    if (!(event.buttons & 1)) {
      pendingDrag = undefined;
      return;
    }
    if (Math.hypot(event.clientX - pendingDrag.x, event.clientY - pendingDrag.y) < 4) return;
    pendingDrag = undefined;
    void request("drag");
  }, true);
  const drag = () => {
    if (!enabled || !press || press.defaultPrevented) return;
    if (macos) {
      window.webkit?.messageHandlers?.openclawWindowDrag?.postMessage({ type: "window-drag" });
    } else if (press.detail > 1 && press.detail % 2 === 0) {
      void request("toggle-maximize");
    } else {
      // GTK's native move grab consumes subsequent clicks, even without motion.
      // Wait for drag intent so a stationary double-click can still restore.
      pendingDrag = { x: press.clientX, y: press.clientY };
    }
  };
  const install = () => {
    if (installed || !enabled) return;
    installed = true;
    if (!macos) {
      window.webkit ??= {};
      window.webkit.messageHandlers ??= {};
      const handlers = window.webkit.messageHandlers;
      // WebKit weakly caches its native registry wrapper; retain our adapter.
      Object.defineProperty(window, "__OPENCLAW_WINDOW_HANDLERS__", { value: handlers, configurable: true });
      Object.defineProperty(handlers, "openclawWindowDrag", {
        value: { postMessage: drag }, configurable: true,
      });
    }
    const root = document.documentElement;
    root.dataset.nativePlatform = config.platform;
    root.classList.add("openclaw-native-desktop");
    root.classList.add(dashboard ? "openclaw-native-web-chrome" : "openclaw-companion-chrome");
    if (dashboard) {
      const style = document.createElement("style");
      style.textContent = config.css;
      document.head.append(style);
    }
    if (!macos) {
      const edge = document.createElement("div");
      edge.className = "openclaw-window-drag-edge";
      edge.setAttribute("aria-hidden", "true");
      edge.addEventListener("mousedown", (event) => {
        drag();
        if (event.button === 0) event.preventDefault();
      });
      document.body.append(edge);
    }
    if (!dashboard) {
      document.querySelector(".brand")?.addEventListener("mousedown", (event) => {
        drag();
        if (event.button === 0) event.preventDefault();
      });
    }
    if (!macos) {
      controls = document.createElement("div");
      controls.hidden = true;
      controls.className = "openclaw-window-controls";
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", "Window controls");
      for (const [action, label, shape] of [
        ["minimize", "Minimize window", '<path d="M3 8h10"/>'],
        ["toggle-maximize", "Maximize window", '<rect class="maximize" x="3.5" y="3.5" width="9" height="9"/><path class="restore" d="M5.5 3.5v-1h8v8h-1m-10-6h8v8h-8z"/>'],
        ["close", "Close window", '<path d="m3.5 3.5 9 9m0-9-9 9"/>'],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = action;
        button.setAttribute("aria-label", label);
        button.title = label;
        button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${shape}</svg>`;
        button.addEventListener("click", () => void request(action));
        controls.append(button);
        if (action === "toggle-maximize") maximize = button;
      }
      document.body.append(controls);
    }
    errorNotice = document.createElement("div");
    errorNotice.className = "openclaw-window-error";
    errorNotice.setAttribute("role", "alert");
    errorNotice.hidden = true;
    document.body.append(errorNotice);
    void syncChrome().then(() => request("state"));
  };
  if (dashboard) {
    window.addEventListener("openclaw:native-window-chrome-available", () => {
      enabled = true;
      window.__OPENCLAW_NATIVE_WEB_CHROME__ = true;
      if (document.readyState !== "loading") install();
    }, { once: true });
  }
  const documentReady = () => {
    if (enabled) install();
    else void syncChrome();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", documentReady, { once: true });
  else documentReady();
}
