(config) => {
  if (window !== window.top || location.origin !== config.origin) return;
  const base = config.base?.replace(/\/$/, "") ?? "";
  if (base && location.pathname !== base && !location.pathname.startsWith(base + "/")) return;

  const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  const actionFailure = config.chrome?.gatewayActionFailed || "Gateway action failed: {error}";
  const failureArguments = new Set(
    [...actionFailure.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(([, name]) => name),
  );
  if (failureArguments.size !== 1 || !failureArguments.has("error")) {
    throw new TypeError("Gateway action failure copy must declare only the error argument");
  }
  const actionFailureText = (error) =>
    actionFailure.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (_token, name) => {
      if (name !== "error") {
        throw new TypeError(`Unexpected Gateway action argument ${name}`);
      }
      return String(error);
    });
  let token;
  let noticeVersion = 0;
  window.addEventListener("openclaw:gateway-notice", () => { noticeVersion += 1; });
  const queued = [];
  const showError = (error) => {
    window.dispatchEvent(new CustomEvent("openclaw:gateway-notice", {
      detail: { message: actionFailureText(error) },
    }));
  };
  const post = async (message) => {
    if (!token) {
      queued.push(message);
      return;
    }
    const requestToken = token;
    const requestNoticeVersion = noticeVersion;
    try {
      await invoke("gateway_request", { message, token: requestToken });
      // A successful native action may still report a credential-storage warning.
      if (requestToken === token && requestNoticeVersion === noticeVersion) {
        window.dispatchEvent(new Event("openclaw:gateway-notice-clear"));
      }
    } catch (error) {
      if (requestToken === token) showError(error);
    }
  };
  window.__OPENCLAW_NATIVE_GATEWAYS__ = config.snapshot;
  window.addEventListener("openclaw:native-gateways-changed", (event) => {
    window.__OPENCLAW_NATIVE_GATEWAYS__ = event.detail;
  });
  window.addEventListener("openclaw:gateway-ready", (event) => {
    token = event.detail.token;
    window.__OPENCLAW_NATIVE_GATEWAYS__ = event.detail.snapshot;
    window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed", {
      detail: event.detail.snapshot,
    }));
    for (const message of queued.splice(0)) void post(message);
  });
  window.webkit ??= {};
  window.webkit.messageHandlers ??= {};
  const handlers = window.webkit.messageHandlers;
  // Retain WebKit's weakly cached registry so our JavaScript adapter survives GC.
  Object.defineProperty(window, "__OPENCLAW_GATEWAY_HANDLERS__", { value: handlers, configurable: true });
  Object.defineProperty(handlers, "openclawGateways", {
    value: { postMessage: post }, configurable: true,
  });
}
