(config) => {
  const allowed = () => window === window.top && location.origin === config.origin &&
    (!config.base || location.pathname === config.base || location.pathname.startsWith(config.base + "/"));
  if (!allowed()) return;
  const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  let documentToken;
  let ready;
  const readiness = new Promise((resolve) => { ready = resolve; });
  window.addEventListener("openclaw:gateway-ready", (event) => {
    documentToken = event.detail.token;
    ready();
  });
  Object.defineProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__", {
    // Released UIs consume only the accepted shared fields. Current UI ignores
    // them and always requests native signing, including after bridge failures.
    value: {
      gatewayUrl: config.gatewayUrl,
      ...config.legacyAuth,
      // Released UI otherwise retains its old token ahead of an accepted password.
      ...(typeof config.legacyAuth?.password === "string" ? { token: null } : {}),
      nativeConnectAuth: true,
    },
    configurable: true,
  });
  Object.defineProperty(window, "OpenClawNativeGatewayAuth", {
    value: {
      async postMessage(raw) {
        const challenge = JSON.parse(raw);
        try {
          await readiness;
          if (!allowed()) throw new Error("The native dashboard document changed.");
          const token = documentToken;
          const response = await invoke("gateway_request", {
            message: { type: "connectAuth", challenge }, token,
          });
          if (!allowed() || token !== documentToken) throw new Error("The native dashboard document changed.");
          return response;
        } catch (error) {
          return { id: challenge.id, error: String(error) };
        }
      },
    },
    configurable: true,
  });
}
