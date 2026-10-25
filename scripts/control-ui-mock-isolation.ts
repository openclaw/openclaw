import type { Plugin } from "vite";

type StandaloneMockIsolationOptions = {
  sandboxUrl?: string;
  allowDesktopPopup?: boolean;
};

/** Runs before preview and app modules; the preview owns Gateway selection. */
function installStandaloneNetworkBoundary(options: StandaloneMockIsolationOptions): void {
  const nativeOpen = window.open.bind(window);
  const isDesktopPath = (pathname: string) =>
    /^\/focus\/desktop(?:\/control)?(?:\/(?:source|session)\/[^/]+)?$/.test(pathname);
  const isDesktopPopup = (url: URL) =>
    options.allowDesktopPopup &&
    url.origin === window.location.origin &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    isDesktopPath(url.pathname);
  const nativeFetch = window.fetch.bind(window);
  const localOrigin = window.location.origin;
  const isLocalResource = (url: URL) =>
    url.origin === localOrigin || url.protocol === "data:" || url.protocol === "blob:";
  const blocked = (capability: string) =>
    new DOMException(
      `Standalone mock blocked ${capability}. Add a local fixture or use pnpm ui:dev for a real Gateway.`,
      "NotSupportedError",
    );

  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!isLocalResource(url)) {
      throw blocked(`fetch to ${url.origin}`);
    }
    // A local resource must not redirect an authenticated request off the fixture server.
    return nativeFetch(request, { redirect: "error" });
  };

  // Full Chromium preconnects iframe destinations before checking frame-src.
  // Reject URL writes before navigation starts; CSP still guards frame contents.
  const checkFrameUrl = (value: string) => {
    const url = new URL(value, window.location.href);
    if (!isLocalResource(url) && url.href !== "about:blank" && url.href !== options.sandboxUrl) {
      throw blocked(`iframe to ${url.origin}`);
    }
  };
  const framePrototype = HTMLIFrameElement.prototype;
  const frameSrc = Object.getOwnPropertyDescriptor(framePrototype, "src");
  if (!frameSrc?.set) {
    throw blocked("unsupported iframe implementation");
  }
  Object.defineProperty(framePrototype, "src", {
    ...frameSrc,
    set(value: string) {
      checkFrameUrl(value);
      frameSrc.set!.call(this, value);
    },
  });
  framePrototype.setAttribute = function (name, value) {
    if (name.toLowerCase() === "src") {
      checkFrameUrl(value);
    }
    Element.prototype.setAttribute.call(this, name, value);
  };
  framePrototype.setAttributeNS = function (namespace, name, value) {
    if (!namespace && name.toLowerCase() === "src") {
      checkFrameUrl(value);
    }
    Element.prototype.setAttributeNS.call(this, namespace, name, value);
  };

  // CSP covers resource loads, not native RTC or top-level navigation. Keep
  // these side effects out of standalone demos, including deferred blank popups.
  for (const capability of ["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport"]) {
    function blockedTransport(): never {
      throw blocked(capability);
    }
    Object.defineProperty(window, capability, { value: blockedTransport });
  }
  window.open = (url, target) => {
    if (url && (!target || target === "_blank")) {
      const destination = new URL(String(url), window.location.href);
      if (isDesktopPopup(destination)) {
        return nativeOpen(destination.href, "_blank", "noopener,noreferrer");
      }
    }
    console.warn(blocked("popup").message);
    return null;
  };
  window.navigation?.addEventListener("navigate", (event) => {
    if (new URL(event.destination.url).origin !== localOrigin) {
      event.preventDefault();
      console.warn(blocked("external navigation").message);
    }
  });
  for (const eventName of ["click", "auxclick"]) {
    // Document handlers get first refusal for in-app destinations such as Link
    // Reader. Block the remaining external navigation before its default action.
    window.addEventListener(eventName, (event) => {
      if (event.defaultPrevented) {
        return;
      }
      const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
      const url = anchor ? new URL(anchor.href) : null;
      const localDownload =
        anchor?.download && (url?.protocol === "blob:" || url?.protocol === "data:");
      const newContext =
        anchor &&
        ((anchor.target && !["_self", "_top", "_parent"].includes(anchor.target)) ||
          event.type === "auxclick" ||
          (event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey)));
      if (
        url &&
        !localDownload &&
        (url.origin !== localOrigin || (newContext && !isDesktopPopup(url)))
      ) {
        event.preventDefault();
        console.warn(blocked("external link").message);
      }
    });
  }
}

export function createStandaloneMockIsolationPlugins(
  options: StandaloneMockIsolationOptions = {},
): Plugin[] {
  const sandbox = options.sandboxUrl ? new URL(options.sandboxUrl) : undefined;
  const contentSecurityPolicy = (host: string | undefined, guardedUi: boolean) => {
    const origin = new URL(`http://${host}`).origin;
    const frameSource = guardedUi && sandbox ? ` ${sandbox.origin}${sandbox.pathname}` : "";
    const popupPermission = guardedUi && options.allowDesktopPopup ? " allow-popups" : "";
    return [
      "default-src 'self'",
      `connect-src 'self' ${origin.replace(/^http:/, "ws:")} blob: data:`,
      // The bundled terminal compiles local Wasm; JavaScript eval stays disabled.
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "media-src 'self' blob: data:",
      "font-src 'self' data:",
      `frame-src 'self' blob: data:${frameSource}`,
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `sandbox allow-scripts allow-same-origin allow-downloads allow-forms${popupPermission}`,
    ].join("; ");
  };
  // tsx can emit __name calls in serialized functions; keep that helper local
  // to the injected script, just like the shared Gateway mock initializer.
  const script = `(() => { const __name = (target) => target; (${installStandaloneNetworkBoundary.toString()})(${JSON.stringify(options)}); })();`;
  return [
    {
      name: "openclaw-control-ui-mock-isolation",
      enforce: "pre",
      configureServer(server) {
        // Install before *all* custom fixture handlers, not only Vite's HTML
        // handler: frame/attachment documents need the same native boundary.
        server.middlewares.use((req, res, next) => {
          res.setHeader("Content-Security-Policy", contentSecurityPolicy(req.headers.host, false));
          res.setHeader("X-DNS-Prefetch-Control", "off");
          next();
        });
        // Vite runs this after base-path stripping and HTML fallback, immediately
        // before indexHtmlMiddleware. Only the actual app entry gets exceptions;
        // fixture/static handlers have already responded with the baseline policy.
        return () => {
          server.middlewares.use((req, res, next) => {
            const pathname = req.url?.split(/[?#]/, 1)[0];
            if (pathname === "/index.html" && req.headers["sec-fetch-dest"] !== "script") {
              res.setHeader(
                "Content-Security-Policy",
                contentSecurityPolicy(req.headers.host, true),
              );
            }
            next();
          });
        };
      },
      transformIndexHtml: {
        order: "pre",
        handler: () => [{ tag: "script", children: script, injectTo: "head-prepend" }],
      },
    },
    {
      name: "openclaw-control-ui-mock-http-misses",
      enforce: "post",
      configureServer(server) {
        // Registered after fixture handlers but before Vite's SPA fallback.
        server.middlewares.use((req, res, next) => {
          const pathname = new URL(req.url ?? "/", "http://mock.invalid").pathname;
          if (!/^\/(?:api|avatar|__openclaw__|__fixtures)\//.test(pathname)) {
            next();
            return;
          }
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Standalone mock has no HTTP fixture for this route." }));
        });
      },
    },
  ];
}
