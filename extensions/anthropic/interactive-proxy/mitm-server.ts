/* oxlint-disable no-underscore-dangle -- `_reqId` / `_requestType` are
   intentional namespace markers on proxy-internal JSON events that flow
   between this server and wrapper.ts, distinguishing proxy-added fields
   from upstream Anthropic API fields. */
/**
 * Two-stage MITM proxy for intercepting Claude CLI's API stream.
 *
 * Stage 1 — HTTP CONNECT proxy: receives CONNECT api.anthropic.com:443 from
 * claude.exe (via HTTPS_PROXY env var) and redirects the tunnel to Stage 2.
 *
 * Stage 2 — Bun TLS server: terminates TLS using our CA-signed leaf cert
 * (trusted by claude via NODE_EXTRA_CA_CERTS), reads plaintext SSE, fires
 * every parsed event to registered handlers, then forwards the unmodified
 * stream upstream.
 *
 * Trust boundary: the CONNECT proxy fails closed. Only `api.anthropic.com`
 * is MITM'd (decrypted); other Anthropic-owned hosts (e.g. statsig.anthropic.com)
 * are tunneled through unchanged WITHOUT decryption; any non-Anthropic CONNECT
 * target is refused with 403. This keeps the loopback proxy from acting as a
 * general open forward proxy while it is alive — it only ever carries the
 * spawned claude process's Anthropic traffic.
 */
import net from "node:net";
import type { CertPaths } from "./cert-manager.js";

export type MitmProxyHandle = {
  connectPort: number;
  onEvent: (handler: (evt: Record<string, unknown>) => void) => void;
  stop: () => Promise<void>;
};

const UPSTREAM_HOST = "api.anthropic.com";
const UPSTREAM_PORT = 443;

// CONNECT allowlist: only Anthropic-owned hosts may tunnel through this proxy.
// `api.anthropic.com` is MITM'd; other `*.anthropic.com` hosts pass through
// undecrypted; everything else is refused. Matching is exact-host or a
// dot-anchored suffix so `evil-anthropic.com` / `anthropic.com.evil.test`
// cannot slip past.
export function isAllowedConnectHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === UPSTREAM_HOST || normalized.endsWith(".anthropic.com");
}

// Whether a CONNECT host is the Anthropic API host we MITM (vs an allowed
// pass-through tunnel). Normalizes the host the same way isAllowedConnectHost
// does, so a mixed-case host like "API.Anthropic.Com" is still routed through
// the MITM path (and its SSE events captured) instead of being treated as a raw
// pass-through tunnel — which would silently stop the backend from streaming.
export function isApiConnectHost(host: string): boolean {
  return host.trim().toLowerCase() === UPSTREAM_HOST;
}

export async function startMitmProxy(certs: CertPaths): Promise<MitmProxyHandle> {
  const eventHandlers: Array<(evt: Record<string, unknown>) => void> = [];
  // Monotonic per-request identifier. claude-code can hold multiple
  // /v1/messages requests in flight concurrently (a real user turn racing
  // with an aux title-gen request, for instance). The wrapper uses _reqId
  // to bind every SSE event back to its originating request so events
  // from a concurrent aux call can't leak into the active turn's
  // accumulator. Reset is unnecessary — the counter only needs to be
  // unique within a single wrapper invocation's lifetime.
  let nextReqId = 1;
  // Track last stop_reason across requests. After "max_tokens", the next
  // request is either a higher-limit retry (same last user msg) or compaction
  // (new compaction prompt as last user msg — caught by content markers).
  // Kept for future heuristics; not used as a standalone classifier because
  // max_output_tokens_recovery also follows max_tokens and we'd misclassify
  // legitimate retries as compaction.
  let lastStopReason = "";

  function emitEvent(evt: Record<string, unknown>): void {
    for (const h of eventHandlers) {
      h(evt);
    }
    if (evt.type === "message_delta") {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (typeof delta?.stop_reason === "string") {
        lastStopReason = delta.stop_reason;
      }
    }
  }

  // Stage 2 — Bun TLS server (decrypts, taps SSE, forwards upstream).
  // Bind on port 0 (OS picks) so concurrent proxy instances can coexist
  // without racing for a preferred port. The backend serializes runs on
  // the same Claude session, but independent sessions still spawn
  // simultaneously.
  const tlsServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    tls: {
      key: Bun.file(certs.leafKeyPath),
      cert: Bun.file(certs.leafCertPath),
    },
    async fetch(req) {
      const url = new URL(req.url);
      const upstreamUrl = `https://${UPSTREAM_HOST}${url.pathname}${url.search}`;

      const headers = new Headers(req.headers);
      headers.set("host", UPSTREAM_HOST);
      headers.set("accept-encoding", "identity");
      for (const hop of [
        "connection",
        "keep-alive",
        "proxy-connection",
        "upgrade",
        "te",
        "trailer",
        "transfer-encoding",
      ]) {
        headers.delete(hop);
      }

      // Classify the outbound /v1/messages request from its body shape, so
      // the wrapper can route the resulting SSE stream without inspecting
      // the request itself. Four categories, applied in order:
      //
      //   "tool_followup" — last message has role "tool" OR its content
      //                     array contains a `tool_result` block. Means
      //                     we're inside Claude's tool-use loop; the
      //                     stream will be tool_use deltas or interim
      //                     reasoning, then the final user-facing turn.
      //   "compaction"    — last user message contains compact.ts's
      //                     summarize prompt markers ("summary should
      //                     include the following sections" plus either
      //                     "continuation summary" or "detailed summary").
      //                     The summary content gets re-streamed as
      //                     thinking_delta downstream.
      //   "auxiliary"     — request carries NO tools. OpenClaw always
      //                     injects `mcp__openclaw__*` tools into the
      //                     claude invocation, so the user's real turn
      //                     always has tools. Internal claude-code
      //                     side-requests (title-gen, classifier,
      //                     skill-search) call /v1/messages without
      //                     tools — that's the structural signal. Model
      //                     family is NOT used because Haiku is a
      //                     legitimate user-facing model on this backend
      //                     (defaultModelRef includes claude-haiku-4-5).
      //   "normal"        — everything else: the real user-facing turn
      //                     that should produce a `result` record.
      //
      // Content markers are the only definitive compaction signal. A prior
      // `max_tokens` stop_reason is tempting as a structural hint, but Claude
      // Code's max_output_tokens_recovery flow ALSO follows max_tokens with
      // the same last user message — using stop_reason as a classifier would
      // misclassify those retries as compaction and drop them.
      let reqBody: string | undefined;
      let requestType: "normal" | "compaction" | "tool_followup" | "auxiliary" = "normal";
      if (req.method === "POST") {
        reqBody = await req.text();
        try {
          const parsed = JSON.parse(reqBody);
          const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
          const msgs: unknown[] = Array.isArray(parsed.messages) ? parsed.messages : [];
          const lastMsg = msgs[msgs.length - 1] as Record<string, unknown> | undefined;
          if (lastMsg) {
            if (lastMsg.role === "tool") {
              requestType = "tool_followup";
            } else if (Array.isArray(lastMsg.content)) {
              const hasToolResult = (lastMsg.content as Record<string, unknown>[]).some(
                (b) => b.type === "tool_result",
              );
              if (hasToolResult) {
                requestType = "tool_followup";
              }
            }
            if (requestType === "normal" && lastMsg.role === "user") {
              const lastContent =
                typeof lastMsg.content === "string"
                  ? lastMsg.content
                  : Array.isArray(lastMsg.content)
                    ? (lastMsg.content as Record<string, unknown>[])
                        .map((b) => (typeof b.text === "string" ? b.text : ""))
                        .join("")
                    : "";
              if (
                lastContent.includes("summary should include the following sections") &&
                (lastContent.includes("continuation summary") ||
                  lastContent.includes("detailed summary"))
              ) {
                requestType = "compaction";
              }
            }
          }
          // Tool-less requests that don't match tool_followup or compaction
          // are claude-code's internal side-calls (title-gen, classifier,
          // skill-search). Classify last so a legitimate user turn that
          // happens to be the FIRST message in a session (lastMsg.role
          // === "user", content is plain text, no tools array yet) still
          // gets "normal" iff hasTools — which OpenClaw guarantees by
          // injecting MCP tools into every interactive claude invocation.
          if (requestType === "normal" && !hasTools) {
            requestType = "auxiliary";
          }
        } catch {
          // Body isn't JSON (shouldn't happen on /v1/messages). Leave the
          // default "normal" classification — if it turns out to be
          // compaction-shaped, the wrapper's response-content fingerprint
          // backup catches it.
        }
      }
      const reqId = nextReqId++;

      let upstream: Response;
      try {
        upstream = await fetch(
          new Request(upstreamUrl, {
            method: req.method,
            headers,
            body: reqBody !== undefined ? reqBody : undefined,
          }),
        );
      } catch {
        return new Response("Bad Gateway", { status: 502 });
      }

      const contentType = upstream.headers.get("content-type") ?? "";
      const isSSE = contentType.includes("text/event-stream");
      const isMessagesEndpoint =
        url.pathname === "/v1/messages" || url.pathname.startsWith("/v1/messages?");
      const status = upstream.status;
      const respHeaders = new Headers(upstream.headers);
      for (const hop of ["connection", "keep-alive", "transfer-encoding", "trailer"]) {
        respHeaders.delete(hop);
      }

      if (!isSSE || !upstream.body || !isMessagesEndpoint) {
        // Non-SSE response on /v1/messages — Anthropic returns these for
        // pre-stream API errors (429 rate-limit, 401 auth, 402 billing,
        // 500/529 overloaded, etc.). Buffer the body once so we can both
        // forward it to claude and surface the error to the wrapper. The
        // wrapper uses this signal to enter its exit path (claude.exe does
        // NOT self-exit on API error — it writes the error to its session
        // JSONL and waits for the next user input, so without this signal
        // the wrapper hangs until OpenClaw's watchdog timeout).
        if (isMessagesEndpoint && status >= 400 && upstream.body) {
          const bodyText = await upstream.text();
          let parsedBody: unknown = bodyText;
          try {
            parsedBody = JSON.parse(bodyText);
          } catch {
            // leave as raw text
          }
          emitEvent({ type: "api_error", status, body: parsedBody });
          return new Response(bodyText, { status, headers: respHeaders });
        }
        return new Response(upstream.body, { status, headers: respHeaders });
      }

      // SSE stream from /v1/messages: tap every event and pass through unchanged
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      let textBuf = "";

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            await writer.write(value);

            textBuf += decoder.decode(value, { stream: true });
            const lines = textBuf.split("\n");
            textBuf = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) {
                continue;
              }
              const raw = line.slice(6).trim();
              if (raw === "[DONE]") {
                continue;
              }
              try {
                const evt = JSON.parse(raw);
                evt._reqId = reqId;
                evt._requestType = requestType;
                emitEvent(evt);
              } catch {
                // malformed SSE line — ignore
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          await writer.close().catch(() => {});
        }
      })();

      return new Response(readable, { status, headers: respHeaders });
    },
  });
  // Bun.serve binds synchronously; `tlsServer.port` is typed as
  // `number | undefined` but is always populated by the time we get here.
  // Assert with a fallback throw so a future runtime change can't quietly
  // pair a `0` upstream port with the net.connect() call below.
  const tlsPort = tlsServer.port;
  if (typeof tlsPort !== "number") {
    throw new Error("interactive-proxy TLS server did not expose a bound port");
  }

  // Stage 1 — HTTP CONNECT proxy. Bind on 0 directly for the same race-free
  // reason as the TLS server above.
  const connectServer = net.createServer((client) => {
    let headerBuf = Buffer.alloc(0);
    let tunneled = false;

    const onData = (chunk: Buffer) => {
      if (tunneled) {
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const str = headerBuf.toString("latin1");
      const headEnd = str.indexOf("\r\n\r\n");
      if (headEnd === -1) {
        return;
      }

      client.removeListener("data", onData);

      const firstLine = str.split("\r\n")[0] ?? "";
      const target = firstLine.split(" ")[1] ?? "";
      const [host, portStr] = target.split(":");
      const targetPort = Number.parseInt(portStr, 10) || 443;

      if (!isAllowedConnectHost(host ?? "")) {
        // Fail closed: never act as a general forward proxy. Only Anthropic
        // hosts are tunneled (api.anthropic.com is MITM'd, others pass through).
        // eslint-disable-next-line no-console
        console.warn(`[openclaw-proxy] refused CONNECT to non-Anthropic host: ${host ?? "(none)"}`);
        client.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        client.destroy();
        return;
      }

      const isApiHost = isApiConnectHost(host);
      const destHost = isApiHost ? "127.0.0.1" : host;
      const destPort = isApiHost ? tlsPort : targetPort;

      const upstreamSocket = net.connect(destPort, destHost, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        tunneled = true;

        const leftover = headerBuf.slice(headEnd + 4);
        if (leftover.length > 0) {
          upstreamSocket.write(leftover);
        }

        client.pipe(upstreamSocket);
        upstreamSocket.pipe(client);
      });

      upstreamSocket.on("error", () => client.destroy());
      client.on("error", () => upstreamSocket.destroy());
    };

    client.on("data", onData);
    client.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    connectServer.listen(0, "127.0.0.1", () => resolve());
    connectServer.on("error", reject);
  });
  const connectAddr = connectServer.address();
  const connectPort = typeof connectAddr === "object" && connectAddr ? connectAddr.port : 0;

  return {
    connectPort,
    onEvent(handler) {
      eventHandlers.push(handler);
    },
    async stop() {
      tlsServer.stop(true);
      await new Promise<void>((resolve) => connectServer.close(() => resolve()));
    },
  };
}
