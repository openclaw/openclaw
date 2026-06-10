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
 * Non-api.anthropic.com CONNECT tunnels (statsig, datadog etc) are passed
 * through to their real destinations unchanged.
 */
import net from "node:net";
import type { CertPaths } from "./cert-manager.js";

export type MitmProxyHandle = {
  connectPort: number;
  onEvent: (handler: (evt: Record<string, unknown>) => void) => void;
  stop: () => Promise<void>;
};

const UPSTREAM_HOST = "api.anthropic.com";

// ---------------------------------------------------------------------------
// Request classification (primary turn vs. sub-agent).
//
// The wrapper needs to know whether a given /v1/messages stream's `end_turn`
// should end the USER-facing turn (the primary) or be neutralized (a
// sub-agent: Task/research/Explore, web search, or any disguised agent).
// Exported as a pure function so it can be unit-tested independently of the
// proxy. Layered, first-decisive-layer-wins; biased to never mis-suppress the
// primary (which would hang) while still catching every sub-agent form.
// ---------------------------------------------------------------------------

export type InteractiveRequestType =
  | "normal"
  | "compaction"
  | "tool_followup"
  | "auxiliary"
  | "subagent";

export type ClassifyState = {
  // True once any request this run advertised a primary "spawner" tool (the
  // Task/Agent tool that launches sub-agents). Gates the by-absence sub-agent
  // layer: an Agent-less request only becomes a sub-agent once a spawner has
  // actually been seen, so a deny-listed-Agent run keeps its primary turn-end
  // instead of hanging.
  primarySpawnerSeen: boolean;
};

export type ClassifyOptions = {
  // Tool names that mark the PRIMARY turn (matched case-insensitively, exact).
  // A conservative structural matcher additionally catches renamed/"disguised"
  // spawner tools by shape. Defaults to DEFAULT_SPAWNER_TOOL_NAMES.
  spawnerToolNames?: readonly string[];
  // System-prompt substrings that POSITIVELY mark a sub-agent request. OFF by
  // default (empty) — enable only once a live capture confirms a stable
  // marker. Correctness never depends on this layer.
  subagentSystemMarkers?: readonly string[];
};

export const DEFAULT_SPAWNER_TOOL_NAMES: readonly string[] = ["Agent", "Task", "TaskCreate"];

function isSpawnerTool(tool: Record<string, unknown>, names: readonly string[]): boolean {
  const name = typeof tool?.name === "string" ? tool.name : "";
  if (!name) {
    return false; // server tools (type-only, e.g. web_search) never spawn agents
  }
  const lower = name.toLowerCase();
  if (names.some((n) => n.toLowerCase() === lower)) {
    return true;
  }
  // Conservative shape match for renamed spawners on the primary turn. Kept
  // tight so a sub-agent's ordinary tool can't be mistaken for a spawner
  // (which would wrongly keep that sub-agent's turn-end live).
  if (/^(agent|task)$/i.test(name)) {
    return true;
  }
  if (/^(dispatch|launch|spawn|create|run)_?(sub_?)?agent$/i.test(name)) {
    return true;
  }
  if (/^task(create|run|spawn|launch|dispatch)$/i.test(name)) {
    return true;
  }
  return false;
}

function isWebSearchTool(tool: Record<string, unknown>): boolean {
  const type = typeof tool?.type === "string" ? tool.type : "";
  if (type.includes("web_search")) {
    return true;
  }
  const name = typeof tool?.name === "string" ? tool.name : "";
  return name.toLowerCase() === "web_search";
}

function systemPromptText(parsed: Record<string, unknown>): string {
  const sys = parsed.system;
  if (typeof sys === "string") {
    return sys;
  }
  if (Array.isArray(sys)) {
    return (sys as Record<string, unknown>[])
      .map((b) => (typeof b?.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
}

/**
 * Classify a /v1/messages request body. `state` is mutated in place (the
 * per-run spawner-seen flag); same (body, state, opts) -> same result + state
 * mutation, so it is deterministic and unit-testable.
 */
export function classifyRequest(
  body: string,
  state: ClassifyState,
  opts?: ClassifyOptions,
): InteractiveRequestType {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Body isn't JSON (shouldn't happen on /v1/messages). Default to "normal";
    // the wrapper's response-content fingerprint backstops compaction.
    return "normal";
  }
  if (!parsed || typeof parsed !== "object") {
    return "normal";
  }

  const spawnerNames = opts?.spawnerToolNames ?? DEFAULT_SPAWNER_TOOL_NAMES;
  const toolList: Record<string, unknown>[] = Array.isArray(parsed.tools)
    ? (parsed.tools as Record<string, unknown>[])
    : [];
  const hasTools = toolList.length > 0;
  const msgs: unknown[] = Array.isArray(parsed.messages) ? parsed.messages : [];
  const lastMsg = msgs[msgs.length - 1] as Record<string, unknown> | undefined;

  let requestType: InteractiveRequestType = "normal";

  if (lastMsg) {
    if (lastMsg.role === "tool") {
      requestType = "tool_followup";
    } else if (Array.isArray(lastMsg.content)) {
      const hasToolResult = (lastMsg.content as Record<string, unknown>[]).some(
        (b) => typeof b?.type === "string" && (b.type as string).endsWith("_result"),
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
                .map((b) => (typeof b?.text === "string" ? b.text : ""))
                .join("")
            : "";
      if (
        lastContent.includes("summary should include the following sections") &&
        (lastContent.includes("continuation summary") || lastContent.includes("detailed summary"))
      ) {
        requestType = "compaction";
      }
    }
  }

  // Tool-less, non-followup, non-compaction request -> claude-code internal
  // side-call (title-gen, classifier, skill-search).
  if (requestType === "normal" && !hasTools) {
    requestType = "auxiliary";
  }

  // Primary-vs-subagent discrimination, layered (first decisive layer wins),
  // only for tool-bearing user-facing turns.
  if (requestType === "normal" || requestType === "tool_followup") {
    // 5a — positive PRIMARY signal: the turn carries a spawner tool. Record it
    // and keep the turn-end. A max_tokens retry of the primary still carries
    // the spawner, so it is never mis-suppressed.
    if (toolList.some((t) => isSpawnerTool(t, spawnerNames))) {
      state.primarySpawnerSeen = true;
      return requestType;
    }
    // 5b — positive SUB-AGENT fingerprint (guarded; only if markers supplied).
    const markers = opts?.subagentSystemMarkers ?? [];
    if (markers.length > 0) {
      const sys = systemPromptText(parsed);
      if (sys && markers.some((m) => sys.includes(m))) {
        return "subagent";
      }
    }
    // 5c — web-search sub-agent: a tiny dedicated stream (server web_search,
    // no spawner, narrow toolset). Independent of state, so it is caught even
    // when the spawner is deny-listed.
    if (toolList.some((t) => isWebSearchTool(t)) && toolList.length <= 3) {
      return "subagent";
    }
    // 5d — by-absence Task sub-agent: no spawner here, but a spawner HAS been
    // seen this run, so sub-agents are possible. Gated on primarySpawnerSeen so
    // a no-spawner run keeps its primary turn-end.
    if (state.primarySpawnerSeen) {
      return "subagent";
    }
  }

  return requestType;
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
  // Per-run classifier state: whether a primary spawner (Task/Agent-style)
  // tool has been advertised yet this run. Gates the by-absence sub-agent
  // layer so an Agent-less request stays primary until a spawner is seen.
  // See classifyRequest above.
  const classifyState: ClassifyState = { primarySpawnerSeen: false };

  function emitEvent(evt: Record<string, unknown>): void {
    for (const h of eventHandlers) {
      h(evt);
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

      // Classify the outbound /v1/messages request from its body shape so the
      // wrapper can route the resulting SSE stream (see classifyRequest above
      // for the layered primary-vs-subagent logic). The only downstream effect
      // is which streams are tagged "subagent" (turn-end suppressed) vs the
      // user-facing "normal"/"tool_followup" turn.
      let reqBody: string | undefined;
      let requestType: InteractiveRequestType = "normal";
      if (req.method === "POST") {
        reqBody = await req.text();
        requestType = classifyRequest(reqBody, classifyState);
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
          // Tag the error with its originating request id + classification so
          // the wrapper only terminalizes the user-facing turn — a transient
          // 4xx/5xx on a concurrent auxiliary/sub-agent request must NOT abort
          // an otherwise-valid main turn.
          emitEvent({
            type: "api_error",
            status,
            body: parsedBody,
            _reqId: reqId,
            _requestType: requestType,
          });
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

      const isApiHost = host === UPSTREAM_HOST;
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
      await new Promise<void>((resolve) => {
        connectServer.close(() => resolve());
      });
    },
  };
}
