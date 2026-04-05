import fs from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { handleQaBusRequest, writeError, writeJson } from "./bus-server.js";
import { createQaBusState, type QaBusState } from "./bus-state.js";
import { createQaRunnerRuntime } from "./harness-runtime.js";
import { qaChannelPlugin, setQaChannelRuntime, type OpenClawConfig } from "./runtime-api.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { runQaSelfCheckAgainstState, type QaSelfCheckResult } from "./self-check.js";

type QaLabLatestReport = {
  outputPath: string;
  markdown: string;
  generatedAt: string;
};

type QaLabBootstrapDefaults = {
  conversationKind: "direct" | "channel";
  conversationId: string;
  senderId: string;
  senderName: string;
};

function injectKickoffMessage(params: {
  state: QaBusState;
  defaults: QaLabBootstrapDefaults;
  kickoffTask: string;
}) {
  return params.state.addInboundMessage({
    conversation: {
      id: params.defaults.conversationId,
      kind: params.defaults.conversationKind,
      ...(params.defaults.conversationKind === "channel"
        ? { title: params.defaults.conversationId }
        : {}),
    },
    senderId: params.defaults.senderId,
    senderName: params.defaults.senderName,
    text: params.kickoffTask,
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as unknown) : {};
}

function detectContentType(filePath: string): string {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "text/html; charset=utf-8";
}

function missingUiHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>QA Lab UI Missing</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f1115; color: #f5f7fb; margin: 0; display: grid; place-items: center; min-height: 100vh; }
      main { max-width: 42rem; padding: 2rem; background: #171b22; border: 1px solid #283140; border-radius: 18px; box-shadow: 0 30px 80px rgba(0,0,0,.35); }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #9ee8d8; }
      h1 { margin-top: 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>QA Lab UI not built</h1>
      <p>Build the private debugger bundle, then reload this page.</p>
      <p><code>pnpm qa:lab:build</code></p>
    </main>
  </body>
</html>`;
}

function resolveUiDistDir() {
  const candidates = [
    fileURLToPath(new URL("../web/dist", import.meta.url)),
    path.resolve(process.cwd(), "extensions/qa-lab/web/dist"),
    path.resolve(process.cwd(), "dist/extensions/qa-lab/web/dist"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function resolveAdvertisedBaseUrl(params: {
  bindHost?: string;
  bindPort: number;
  advertiseHost?: string;
  advertisePort?: number;
}) {
  const advertisedHost =
    params.advertiseHost?.trim() ||
    (params.bindHost && params.bindHost !== "0.0.0.0" ? params.bindHost : "127.0.0.1");
  const advertisedPort =
    typeof params.advertisePort === "number" && Number.isFinite(params.advertisePort)
      ? params.advertisePort
      : params.bindPort;
  return `http://${advertisedHost}:${advertisedPort}`;
}

function createBootstrapDefaults(autoKickoffTarget?: string): QaLabBootstrapDefaults {
  if (autoKickoffTarget === "channel") {
    return {
      conversationKind: "channel",
      conversationId: "qa-lab",
      senderId: "qa-operator",
      senderName: "QA Operator",
    };
  }
  return {
    conversationKind: "direct",
    conversationId: "qa-operator",
    senderId: "qa-operator",
    senderName: "QA Operator",
  };
}

function isControlUiProxyPath(pathname: string) {
  return pathname === "/control-ui" || pathname.startsWith("/control-ui/");
}

function rewriteControlUiProxyPath(pathname: string, search: string) {
  const stripped = pathname === "/control-ui" ? "/" : pathname.slice("/control-ui".length) || "/";
  return `${stripped}${search}`;
}

function rewriteEmbeddedControlUiHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[] | number | undefined> {
  const rewritten: Record<string, string | string[] | number | undefined> = { ...headers };
  delete rewritten["x-frame-options"];

  const csp = headers["content-security-policy"];
  if (typeof csp === "string") {
    rewritten["content-security-policy"] = csp.includes("frame-ancestors")
      ? csp.replace(/frame-ancestors\s+[^;]+/i, "frame-ancestors 'self'")
      : `${csp}; frame-ancestors 'self'`;
  }

  return rewritten;
}

async function proxyHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  target: URL;
  pathname: string;
  search: string;
}) {
  const client = params.target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstreamReq = client(
    {
      protocol: params.target.protocol,
      hostname: params.target.hostname,
      port: params.target.port || (params.target.protocol === "https:" ? 443 : 80),
      method: params.req.method,
      path: rewriteControlUiProxyPath(params.pathname, params.search),
      headers: {
        ...params.req.headers,
        host: params.target.host,
      },
    },
    (upstreamRes) => {
      params.res.writeHead(
        upstreamRes.statusCode ?? 502,
        rewriteEmbeddedControlUiHeaders(upstreamRes.headers),
      );
      upstreamRes.pipe(params.res);
    },
  );

  upstreamReq.on("error", (error) => {
    if (!params.res.headersSent) {
      writeError(params.res, 502, error);
      return;
    }
    params.res.destroy(error);
  });

  if (params.req.method === "GET" || params.req.method === "HEAD") {
    upstreamReq.end();
    return;
  }
  params.req.pipe(upstreamReq);
}

function proxyUpgradeRequest(params: {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  target: URL;
}) {
  const requestUrl = new URL(params.req.url ?? "/", "http://127.0.0.1");
  const port = Number(params.target.port || (params.target.protocol === "https:" ? 443 : 80));
  const upstream =
    params.target.protocol === "https:"
      ? tls.connect({
          host: params.target.hostname,
          port,
          servername: params.target.hostname,
        })
      : net.connect({
          host: params.target.hostname,
          port,
        });

  const headerLines: string[] = [];
  for (let index = 0; index < params.req.rawHeaders.length; index += 2) {
    const name = params.req.rawHeaders[index];
    const value = params.req.rawHeaders[index + 1] ?? "";
    if (name.toLowerCase() === "host") {
      continue;
    }
    headerLines.push(`${name}: ${value}`);
  }

  upstream.once("connect", () => {
    const requestText = [
      `${params.req.method ?? "GET"} ${rewriteControlUiProxyPath(requestUrl.pathname, requestUrl.search)} HTTP/${params.req.httpVersion}`,
      `Host: ${params.target.host}`,
      ...headerLines,
      "",
      "",
    ].join("\r\n");
    upstream.write(requestText);
    if (params.head.length > 0) {
      upstream.write(params.head);
    }
    upstream.pipe(params.socket);
    params.socket.pipe(upstream);
  });

  const closeBoth = () => {
    if (!params.socket.destroyed) {
      params.socket.destroy();
    }
    if (!upstream.destroyed) {
      upstream.destroy();
    }
  };

  upstream.on("error", () => {
    if (!params.socket.destroyed) {
      params.socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
    closeBoth();
  });
  params.socket.on("error", closeBoth);
  params.socket.on("close", closeBoth);
}

function tryResolveUiAsset(pathname: string): string | null {
  const distDir = resolveUiDistDir();
  if (!fs.existsSync(distDir)) {
    return null;
  }
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const decoded = decodeURIComponent(safePath);
  const candidate = path.normalize(path.join(distDir, decoded));
  if (!candidate.startsWith(distDir)) {
    return null;
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }
  const fallback = path.join(distDir, "index.html");
  return fs.existsSync(fallback) ? fallback : null;
}

function createQaLabConfig(baseUrl: string): OpenClawConfig {
  return {
    channels: {
      "qa-channel": {
        enabled: true,
        baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        allowFrom: ["*"],
      },
    },
  };
}

async function startQaGatewayLoop(params: { state: QaBusState; baseUrl: string }) {
  const runtime = createQaRunnerRuntime();
  setQaChannelRuntime(runtime);
  const cfg = createQaLabConfig(params.baseUrl);
  const account = qaChannelPlugin.config.resolveAccount(cfg, "default");
  const abort = new AbortController();
  const task = qaChannelPlugin.gateway?.startAccount?.({
    accountId: account.accountId,
    account,
    cfg,
    runtime: {
      log: () => undefined,
      error: () => undefined,
      exit: () => undefined,
    },
    abortSignal: abort.signal,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getStatus: () => ({
      accountId: account.accountId,
      configured: true,
      enabled: true,
      running: true,
    }),
    setStatus: () => undefined,
  });
  return {
    cfg,
    async stop() {
      abort.abort();
      await task;
    },
  };
}

export async function startQaLabServer(params?: {
  host?: string;
  port?: number;
  outputPath?: string;
  advertiseHost?: string;
  advertisePort?: number;
  controlUiUrl?: string;
  controlUiToken?: string;
  controlUiProxyTarget?: string;
  autoKickoffTarget?: string;
  embeddedGateway?: string;
  sendKickoffOnStart?: boolean;
}) {
  const state = createQaBusState();
  let latestReport: QaLabLatestReport | null = null;
  const scenarioCatalog = readQaBootstrapScenarioCatalog();
  const bootstrapDefaults = createBootstrapDefaults(params?.autoKickoffTarget);
  const controlUiProxyTarget = params?.controlUiProxyTarget?.trim()
    ? new URL(params.controlUiProxyTarget)
    : null;
  let gateway:
    | {
        cfg: OpenClawConfig;
        stop: () => Promise<void>;
      }
    | undefined;
  const embeddedGatewayEnabled = params?.embeddedGateway !== "disabled";

  let publicBaseUrl = "";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (await handleQaBusRequest({ req, res, state })) {
      return;
    }

    try {
      if (controlUiProxyTarget && isControlUiProxyPath(url.pathname)) {
        await proxyHttpRequest({
          req,
          res,
          target: controlUiProxyTarget,
          pathname: url.pathname,
          search: url.search,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/bootstrap") {
        const controlUiUrl = controlUiProxyTarget
          ? `${publicBaseUrl}/control-ui/`
          : params?.controlUiUrl?.trim() || null;
        const controlUiEmbeddedUrl =
          controlUiUrl && params?.controlUiToken
            ? `${controlUiUrl.replace(/\/?$/, "/")}#token=${encodeURIComponent(params.controlUiToken)}`
            : controlUiUrl;
        writeJson(res, 200, {
          baseUrl: publicBaseUrl,
          latestReport,
          controlUiUrl,
          controlUiEmbeddedUrl,
          kickoffTask: scenarioCatalog.kickoffTask,
          scenarios: scenarioCatalog.scenarios,
          defaults: bootstrapDefaults,
        });
        return;
      }
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
        writeJson(res, 200, { ok: true, status: "live" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        writeJson(res, 200, state.getSnapshot());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/report") {
        writeJson(res, 200, { report: latestReport });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        state.reset();
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/inbound/message") {
        const body = await readJson(req);
        writeJson(res, 200, {
          message: state.addInboundMessage(body as Parameters<QaBusState["addInboundMessage"]>[0]),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/kickoff") {
        writeJson(res, 200, {
          message: injectKickoffMessage({
            state,
            defaults: bootstrapDefaults,
            kickoffTask: scenarioCatalog.kickoffTask,
          }),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/scenario/self-check") {
        const result = await runQaSelfCheckAgainstState({
          state,
          cfg: gateway?.cfg ?? createQaLabConfig(listenUrl),
          outputPath: params?.outputPath,
        });
        latestReport = {
          outputPath: result.outputPath,
          markdown: result.report,
          generatedAt: new Date().toISOString(),
        };
        writeJson(res, 200, serializeSelfCheck(result));
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        writeError(res, 404, "not found");
        return;
      }

      const asset = tryResolveUiAsset(url.pathname);
      if (!asset) {
        const html = missingUiHtml();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        res.end(html);
        return;
      }

      const body = fs.readFileSync(asset);
      res.writeHead(200, {
        "content-type": detectContentType(asset),
        "content-length": body.byteLength,
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(body);
    } catch (error) {
      writeError(res, 500, error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params?.port ?? 0, params?.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("qa-lab failed to bind");
  }
  const listenUrl = resolveAdvertisedBaseUrl({
    bindHost: params?.host ?? "127.0.0.1",
    bindPort: address.port,
  });
  publicBaseUrl = resolveAdvertisedBaseUrl({
    bindHost: params?.host ?? "127.0.0.1",
    bindPort: address.port,
    advertiseHost: params?.advertiseHost,
    advertisePort: params?.advertisePort,
  });
  if (embeddedGatewayEnabled) {
    gateway = await startQaGatewayLoop({ state, baseUrl: listenUrl });
  }
  if (params?.sendKickoffOnStart) {
    injectKickoffMessage({
      state,
      defaults: bootstrapDefaults,
      kickoffTask: scenarioCatalog.kickoffTask,
    });
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!controlUiProxyTarget || !isControlUiProxyPath(url.pathname)) {
      socket.destroy();
      return;
    }
    proxyUpgradeRequest({
      req,
      socket,
      head,
      target: controlUiProxyTarget,
    });
  });

  return {
    baseUrl: publicBaseUrl,
    listenUrl,
    state,
    async runSelfCheck() {
      const result = await runQaSelfCheckAgainstState({
        state,
        cfg: gateway?.cfg ?? createQaLabConfig(listenUrl),
        outputPath: params?.outputPath,
      });
      latestReport = {
        outputPath: result.outputPath,
        markdown: result.report,
        generatedAt: new Date().toISOString(),
      };
      return result;
    },
    async stop() {
      await gateway?.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function serializeSelfCheck(result: QaSelfCheckResult) {
  return {
    outputPath: result.outputPath,
    report: result.report,
    checks: result.checks,
    scenario: result.scenarioResult,
  };
}
