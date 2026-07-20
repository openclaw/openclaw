export type SandboxHostCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

export const SANDBOX_HOST_PATH = "/mcp-app-sandbox";
const SANDBOX_HOST_PORT_OFFSET = 1;
const SANDBOX_HOST_CSP_QUERY = "csp";
const SANDBOX_HOST_CSP_MAX_JSON_BYTES = 5 * 1024;
const SANDBOX_HOST_CSP_MAX_HEADER_BYTES = 6 * 1024;
const SANDBOX_HOST_CSP_MAX_ENCODED_BYTES = Math.ceil(SANDBOX_HOST_CSP_MAX_JSON_BYTES / 3) * 4 + 4;

// WebRTC traffic is not governed by CSP connect-src. This bootstrap runs as
// the first script in every inner document so untrusted content cannot create
// peer/data connections outside its declared network capability.
const SANDBOX_DOCUMENT_GUARD_HTML = `<script>(()=>{
  const fail=()=>{window.stop();document.open();document.write("<!doctype html><title>Sandbox unavailable</title>");document.close();throw new Error("sandbox WebRTC isolation failed");};
  const names=["RTCPeerConnection","webkitRTCPeerConnection","RTCIceGatherer","RTCIceTransport","RTCDtlsTransport","RTCSctpTransport","RTCDataChannel"];
  for(const name of names){
    try{Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});}catch{}
    if(globalThis[name]!==undefined)fail();
  }
})();</script>`;

function resolveLeadingDoctypeEnd(html: string): number {
  let index = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  const whitespace = new Set([9, 10, 12, 13, 32]);
  const skipWhitespace = () => {
    while (whitespace.has(html.charCodeAt(index))) {
      index += 1;
    }
  };
  skipWhitespace();
  while (html.startsWith("<!--", index)) {
    const commentEnd = html.indexOf("-->", index + 4);
    if (commentEnd < 0) {
      return 0;
    }
    index = commentEnd + 3;
    skipWhitespace();
  }
  if (html.slice(index, index + 9).toLowerCase() !== "<!doctype") {
    return 0;
  }
  let quote = "";
  for (let cursor = index + 9; cursor < html.length; cursor += 1) {
    const character = html[cursor];
    if (quote) {
      if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return cursor + 1;
    }
  }
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeDomains(
  value: unknown,
  options?: { allowWebSocket?: boolean },
): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const allowedProtocols = options?.allowWebSocket
    ? new Set(["http:", "https:", "ws:", "wss:"])
    : new Set(["http:", "https:"]);
  const entries = value
    .filter((entry): entry is string => {
      if (
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 2048 ||
        entry !== entry.trim()
      ) {
        return false;
      }
      for (let index = 0; index < entry.length; index += 1) {
        const code = entry.charCodeAt(index);
        if (code <= 31 || code === 127) {
          return false;
        }
      }
      let parsed: URL;
      try {
        parsed = new URL(entry);
      } catch {
        return false;
      }
      if (
        !allowedProtocols.has(parsed.protocol) ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.pathname !== "/" ||
        parsed.search !== "" ||
        parsed.hash !== ""
      ) {
        return false;
      }
      // URL parsing validates bracketed IPv6. MCP Apps additionally support one
      // leading wildcard label, while board declarations arrive as exact hosts.
      return (
        /^\[[0-9A-Fa-f:.]+\]$/u.test(parsed.hostname) ||
        /^(?:\*\.)?[A-Za-z0-9.-]+$/u.test(parsed.hostname)
      );
    })
    .map((entry) => new URL(entry).origin);
  return entries.length > 0 ? entries : undefined;
}

export function normalizeSandboxHostCsp(value: unknown): SandboxHostCsp | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const csp: SandboxHostCsp = {
    connectDomains: normalizeDomains(record.connectDomains, { allowWebSocket: true }),
    resourceDomains: normalizeDomains(record.resourceDomains),
    frameDomains: normalizeDomains(record.frameDomains),
    baseUriDomains: normalizeDomains(record.baseUriDomains),
  };
  if (!Object.values(csp).some(Boolean)) {
    return undefined;
  }
  const jsonBytes = Buffer.byteLength(JSON.stringify(csp), "utf8");
  const headerBytes = Buffer.byteLength(buildSandboxHostContentSecurityPolicy(csp), "utf8");
  if (
    jsonBytes > SANDBOX_HOST_CSP_MAX_JSON_BYTES ||
    headerBytes > SANDBOX_HOST_CSP_MAX_HEADER_BYTES
  ) {
    throw new Error("MCP App CSP metadata exceeds safe HTTP limits");
  }
  return csp;
}

function encodeCsp(csp?: SandboxHostCsp): string | undefined {
  const normalized = normalizeSandboxHostCsp(csp);
  if (!normalized) {
    return undefined;
  }
  return Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
}

export function buildSandboxHostPath(csp?: SandboxHostCsp): string {
  const encoded = encodeCsp(csp);
  return encoded ? `${SANDBOX_HOST_PATH}?${SANDBOX_HOST_CSP_QUERY}=${encoded}` : SANDBOX_HOST_PATH;
}

export function resolveSandboxHostPort(gatewayPort: number, configuredPort?: number): number {
  const sandboxPort = configuredPort ?? gatewayPort + SANDBOX_HOST_PORT_OFFSET;
  if (
    !Number.isInteger(gatewayPort) ||
    gatewayPort < 1 ||
    gatewayPort > 65535 ||
    !Number.isInteger(sandboxPort) ||
    sandboxPort < 1 ||
    sandboxPort > 65535 ||
    sandboxPort === gatewayPort
  ) {
    throw new Error("MCP Apps require distinct valid Gateway and sandbox ports");
  }
  return sandboxPort;
}

// Malformed input must throw: the gateway sandbox endpoint relies on it to fail
// closed with 400 instead of serving proxy HTML under a default policy. That
// includes valid JSON that is not a usable CSP — encodeCsp omits the query
// param entirely in that case, so a present-but-empty value is never legitimate.
export function decodeSandboxHostCsp(value: string | null): SandboxHostCsp | undefined {
  if (value === null) {
    return undefined;
  }
  if (value.length > SANDBOX_HOST_CSP_MAX_ENCODED_BYTES) {
    throw new Error("MCP App CSP metadata is too large");
  }
  const decoded = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64url")),
  ) as unknown;
  const normalized = normalizeSandboxHostCsp(decoded);
  if (!normalized) {
    throw new Error("MCP App CSP metadata is not a valid policy");
  }
  return normalized;
}

/** Trusted outer document. Untrusted content is written only into its inner iframe. */
export function buildSandboxHostProxyHtml(): string {
  const serializedDocumentGuard = JSON.stringify(SANDBOX_DOCUMENT_GUARD_HTML).replaceAll(
    "<",
    "\\u003c",
  );
  const serializedDoctypeResolver = resolveLeadingDoctypeEnd.toString();
  return `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>MCP App sandbox</title>
<style>html,body{height:100%;margin:0;background:transparent}iframe{display:block;width:100%;height:100%;border:0;background:transparent}</style>
<body>
<script>
(() => {
  if (window.self === window.top) throw new Error("invalid MCP App sandbox host");
  let hostOrigin;
  try {
    const referrer = new URL(document.referrer);
    if (referrer.protocol !== "http:" && referrer.protocol !== "https:") throw new Error();
    hostOrigin = referrer.origin;
  } catch { throw new Error("invalid MCP App sandbox parent"); }
  try { void window.top.document; throw new Error("MCP App sandbox isolation failed"); } catch (error) {
    if (error instanceof Error && error.message === "MCP App sandbox isolation failed") throw error;
  }
  const createInner = () => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    return frame;
  };
  const documentGuard = ${serializedDocumentGuard};
  const resolveLeadingDoctypeEnd = ${serializedDoctypeResolver};
  const guardDocument = html => {
    const doctypeEnd = resolveLeadingDoctypeEnd(html);
    return html.slice(0, doctypeEnd) + documentGuard + html.slice(doctypeEnd);
  };
  let inner = createInner();
  document.body.appendChild(inner);
  let widgetBridgePortOffered = false;
  window.addEventListener("message", (event) => {
    if (event.source === window.parent) {
      if (event.origin !== hostOrigin) return;
      if (event.data?.method === "ui/notifications/sandbox-resource-ready") {
        const params = event.data.params ?? {};
        if (typeof params.html === "string") {
          // Replace the browsing context so a superseded document cannot race
          // the new wrapper's first private bridge-port offer.
          const nextInner = createInner();
          widgetBridgePortOffered = false;
          nextInner.srcdoc = guardDocument(params.html);
          inner.replaceWith(nextInner);
          inner = nextInner;
        }
        return;
      }
      if (typeof event.data?.method === "string" && event.data.method.startsWith("ui/notifications/sandbox-")) return;
      inner.contentWindow?.postMessage(event.data, "*");
      return;
    }
    if (event.source === inner.contentWindow) {
      if (typeof event.data?.method === "string" && event.data.method.startsWith("ui/notifications/sandbox-")) return;
      if (event.data?.type === "openclaw:widget-bridge-port-offer") {
        const port = event.ports[0];
        if (!widgetBridgePortOffered && port) {
          widgetBridgePortOffered = true;
          window.parent.postMessage(event.data, hostOrigin, [port]);
        } else {
          port?.close();
        }
        return;
      }
      window.parent.postMessage(event.data, hostOrigin);
    }
  });
  window.parent.postMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-proxy-ready",
    params: { sandboxUrl: window.location.href },
  }, hostOrigin);
})();
</script>
</body>`;
}

/** HTTP response policy for the isolated proxy and its inner about:blank content. */
export function buildSandboxHostContentSecurityPolicy(csp?: SandboxHostCsp): string {
  const resources = csp?.resourceDomains ?? [];
  const connections = csp?.connectDomains ?? [];
  const frames = csp?.frameDomains ?? [];
  const bases = csp?.baseUriDomains ?? [];
  const sources = (values: string[]) => (values.length > 0 ? values.join(" ") : "'none'");
  const directives = [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${resources.join(" ")}`.trim(),
    `style-src 'self' 'unsafe-inline' ${resources.join(" ")}`.trim(),
    `img-src 'self' data: ${resources.join(" ")}`.trim(),
    `media-src 'self' data: ${resources.join(" ")}`.trim(),
    `connect-src ${sources(connections)}`,
    // This policy belongs to the trusted outer document, so frame-src also
    // governs replacement navigations of its untrusted inner browsing context.
    `frame-src ${sources(frames)}`,
    `base-uri ${bases.length > 0 ? bases.join(" ") : "'self'"}`,
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors http: https:",
  ];
  if (csp) {
    directives.splice(5, 0, `font-src 'self' ${resources.join(" ")}`.trim());
  }
  return directives.join("; ");
}
