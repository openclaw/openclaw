import type { IncomingMessage, ServerResponse } from "node:http";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { DEFAULT_WEBHOOK_PATH } from "./config.js";
import {
  consumeDailyflowsPairing,
  createDailyflowsPairing,
  normalizeGatewayUrl,
} from "./pairing.js";
import { renderQrPngBase64 } from "./qr.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function escapeHtml(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveGatewayUrlFromRequest(req: IncomingMessage): string | null {
  const protoHeader = String(req.headers["x-forwarded-proto"] ?? "").trim();
  const proto = protoHeader ? protoHeader.split(",")[0]?.trim() : "";
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").trim();
  if (!host) {
    return null;
  }
  const scheme =
    proto || ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  return `${scheme}://${host}`;
}

function wantsJson(req: IncomingMessage, url: URL): boolean {
  const format = url.searchParams.get("format");
  if (format === "json") {
    return true;
  }
  const accept = String(req.headers.accept ?? "");
  return accept.includes("application/json");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        const parsed = JSON.parse(body) as Record<string, unknown>;
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function renderPairingHtml(params: {
  gatewayUrl: string;
  accountId: string;
  payload: string;
  pairCode: string;
  expiresAt: number;
  qrPngBase64: string;
}) {
  const expiresInMin = Math.max(1, Math.round((params.expiresAt - Date.now()) / 60000));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Dailyflows Pairing</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #0b0d12; color: #fff; margin: 0; padding: 24px; }
    .card { max-width: 560px; margin: 24px auto; padding: 24px; background: #141826; border-radius: 16px; }
    .qr { display: block; margin: 16px auto; width: 260px; height: 260px; background: #fff; padding: 12px; border-radius: 12px; }
    .muted { color: rgba(255,255,255,0.7); font-size: 13px; }
    .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.5); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Dailyflows Pairing</h1>
    <p class="muted">Scan this QR in Dailyflows → Voice Assistant to connect your OpenClaw gateway.</p>
    <img class="qr" src="data:image/png;base64,${params.qrPngBase64}" alt="Dailyflows pairing QR" />
    <p class="label">Pair code</p>
    <p class="mono">${escapeHtml(params.pairCode)}</p>
    <p class="label">Gateway URL</p>
    <p class="mono">${escapeHtml(params.gatewayUrl)}</p>
    <p class="label">Account</p>
    <p class="mono">${escapeHtml(params.accountId)}</p>
    <p class="muted">Expires in about ${expiresInMin} minutes.</p>
  </div>
</body>
</html>`;
}

function buildConfigUpdate(params: {
  current: Record<string, unknown>;
  accountId: string;
  outboundUrl: string;
  outboundToken: string;
  webhookSecret: string;
  webhookPath: string;
}) {
  const next = { ...params.current } as Record<string, unknown>;
  const channels = { ...(next.channels as Record<string, unknown> | undefined) };
  const dailyflows: Record<string, unknown> = {
    ...(channels.dailyflows as Record<string, unknown> | undefined),
    enabled: true,
    webhookPath: params.webhookPath,
  };
  const accounts = {
    ...(dailyflows.accounts as Record<string, unknown> | undefined),
  };
  const account = {
    ...(accounts[params.accountId] as Record<string, unknown> | undefined),
    enabled: true,
    outboundUrl: params.outboundUrl,
    outboundToken: params.outboundToken,
    webhookSecret: params.webhookSecret,
  };
  accounts[params.accountId] = account;
  dailyflows.accounts = accounts;
  channels.dailyflows = dailyflows;
  next.channels = channels;

  const plugins: Record<string, unknown> = { ...(next.plugins as Record<string, unknown> | undefined) };
  const entries: Record<string, unknown> = { ...(plugins.entries as Record<string, unknown> | undefined) };
  entries.dailyflows = {
    ...(entries.dailyflows as Record<string, unknown> | undefined),
    enabled: true,
  };
  plugins.entries = entries;
  next.plugins = plugins;

  return next;
}

export function createDailyflowsPairingRoute(api: OpenClawPluginApi) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET") {
      const accountId = url.searchParams.get("accountId")?.trim() || "default";
      const gatewayUrlRaw = url.searchParams.get("gatewayUrl")?.trim() || resolveGatewayUrlFromRequest(req) || "";
      const gatewayUrl = normalizeGatewayUrl(gatewayUrlRaw);

      if (!gatewayUrl) {
        if (wantsJson(req, url)) {
          sendJson(res, 400, { ok: false, error: "gatewayUrl missing or invalid (https required)" });
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:24px;">
          <h1>Dailyflows Pairing</h1>
          <p>Provide a public https:// gateway URL to generate a pairing QR.</p>
          <form method="GET">
            <label>Gateway URL: <input name="gatewayUrl" style="width:320px" /></label><br/><br/>
            <label>Account ID: <input name="accountId" value="default" /></label><br/><br/>
            <button type="submit">Generate QR</button>
          </form>
        </body></html>`);
        return;
      }

      const pairing = createDailyflowsPairing({ gatewayUrl, accountId });
      if (wantsJson(req, url)) {
        sendJson(res, 200, {
          ok: true,
          gatewayUrl,
          accountId,
          pairCode: pairing.pairCode,
          payload: pairing.payload,
          expiresAt: pairing.expiresAt,
        });
        return;
      }

      const qrPngBase64 = await renderQrPngBase64(pairing.payload);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        renderPairingHtml({
          gatewayUrl,
          accountId,
          payload: pairing.payload,
          pairCode: pairing.pairCode,
          expiresAt: pairing.expiresAt,
          qrPngBase64,
        }),
      );
      return;
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      if (!body) {
        sendJson(res, 400, { ok: false, error: "invalid json" });
        return;
      }
      const pairCode = typeof body.pairCode === "string" ? body.pairCode.trim() : "";
      const outboundUrl = typeof body.outboundUrl === "string" ? body.outboundUrl.trim() : "";
      const outboundToken = typeof body.outboundToken === "string" ? body.outboundToken.trim() : "";
      const webhookSecret = typeof body.webhookSecret === "string" ? body.webhookSecret.trim() : "";
      const accountIdRaw = typeof body.accountId === "string" ? body.accountId.trim() : "";
      const webhookPath = typeof body.webhookPath === "string" ? body.webhookPath.trim() : DEFAULT_WEBHOOK_PATH;

      if (!pairCode || !outboundUrl || !outboundToken || !webhookSecret) {
        sendJson(res, 400, { ok: false, error: "missing required fields" });
        return;
      }

      const entry = consumeDailyflowsPairing(pairCode);
      if (!entry) {
        sendJson(res, 401, { ok: false, error: "invalid or expired pair code" });
        return;
      }
      const accountId = accountIdRaw || entry.accountId;

      const current = api.runtime.config.loadConfig() as Record<string, unknown>;
      const next = buildConfigUpdate({
        current,
        accountId,
        outboundUrl,
        outboundToken,
        webhookSecret,
        webhookPath,
      });

      await api.runtime.config.writeConfigFile(next);
      sendJson(res, 200, { ok: true });
      return;
    }

    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
  };
}
