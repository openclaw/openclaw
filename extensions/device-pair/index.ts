import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import os from "node:os";
import { approveDevicePairing, listDevicePairing } from "openclaw/plugin-sdk";

const DEFAULT_GATEWAY_PORT = 18789;

type DevicePairPluginConfig = {
  publicUrl?: string;
};

type SetupPayload = {
  url: string;
  token?: string;
  password?: string;
};

type ResolveUrlResult = {
  url?: string;
  source?: string;
  error?: string;
};

type ResolveAuthResult = {
  token?: string;
  password?: string;
  label?: string;
  error?: string;
};

function normalizeUrl(raw: string, schemeFallback: "ws" | "wss"): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    const scheme = parsed.protocol.replace(":", "");
    if (!scheme) {
      return null;
    }
    const resolvedScheme = scheme === "http" ? "ws" : scheme === "https" ? "wss" : scheme;
    if (resolvedScheme !== "ws" && resolvedScheme !== "wss") {
      return null;
    }
    const host = parsed.hostname;
    if (!host) {
      return null;
    }
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${resolvedScheme}://${host}${port}`;
  } catch {
    // Fall through to host:port parsing.
  }

  const withoutPath = trimmed.split("/")[0] ?? "";
  if (!withoutPath) {
    return null;
  }
  return `${schemeFallback}://${withoutPath}`;
}

function resolveGatewayPort(cfg: OpenClawPluginApi["config"]): number {
  const envRaw =
    process.env.OPENCLAW_GATEWAY_PORT?.trim() || process.env.CLAWDBOT_GATEWAY_PORT?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const configPort = cfg.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort) && configPort > 0) {
    return configPort;
  }
  return DEFAULT_GATEWAY_PORT;
}

function resolveScheme(
  cfg: OpenClawPluginApi["config"],
  opts?: { forceSecure?: boolean },
): "ws" | "wss" {
  if (opts?.forceSecure) {
    return "wss";
  }
  return cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length != 4) {
    return false;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return false;
}

function isTailnetIPv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 100 && b >= 64 && b <= 127;
}

function pickMatchingIPv4(predicate: (address: string) => boolean): string | null {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      const family = entry?.family;
      // Check for IPv4 (string "IPv4" on Node 18+, number 4 on older)
      const isIpv4 = family === "IPv4" || String(family) === "4";
      if (!entry || entry.internal || !isIpv4) {
        continue;
      }
      const address = entry.address?.trim() ?? "";
      if (!address) {
        continue;
      }
      if (predicate(address)) {
        return address;
      }
    }
  }
  return null;
}

function pickLanIPv4(): string | null {
  return pickMatchingIPv4(isPrivateIPv4);
}

function pickTailnetIPv4(): string | null {
  return pickMatchingIPv4(isTailnetIPv4);
}

async function resolveTailnetHost(api: OpenClawPluginApi): Promise<string | null> {
  const candidates = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  for (const candidate of candidates) {
    try {
      const result = await api.runtime.system.runCommandWithTimeout(
        [candidate, "status", "--json"],
        {
          timeoutMs: 5000,
        },
      );
      if (result.code !== 0) {
        continue;
      }
      const raw = result.stdout.trim();
      if (!raw) {
        continue;
      }
      const parsed = parsePossiblyNoisyJsonObject(raw);
      const self =
        typeof parsed.Self === "object" && parsed.Self !== null
          ? (parsed.Self as Record<string, unknown>)
          : undefined;
      const dns = typeof self?.DNSName === "string" ? self.DNSName : undefined;
      if (dns && dns.length > 0) {
        return dns.replace(/\.$/, "");
      }
      const ips = Array.isArray(self?.TailscaleIPs) ? (self?.TailscaleIPs as string[]) : [];
      if (ips.length > 0) {
        return ips[0] ?? null;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function parsePossiblyNoisyJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return {};
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveAuth(cfg: OpenClawPluginApi["config"]): ResolveAuthResult {
  const mode = cfg.gateway?.auth?.mode;
  const token =
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
    cfg.gateway?.auth?.token?.trim();
  const password =
    process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
    process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
    cfg.gateway?.auth?.password?.trim();

  if (mode === "password") {
    if (!password) {
      return { error: "Gateway auth is set to password, but no password is configured." };
    }
    return { password, label: "password" };
  }
  if (mode === "token") {
    if (!token) {
      return { error: "Gateway auth is set to token, but no token is configured." };
    }
    return { token, label: "token" };
  }
  if (token) {
    return { token, label: "token" };
  }
  if (password) {
    return { password, label: "password" };
  }
  return { error: "Gateway auth is not configured (no token or password)." };
}

async function resolveGatewayUrl(api: OpenClawPluginApi): Promise<ResolveUrlResult> {
  const cfg = api.config;
  const pluginCfg = (api.pluginConfig ?? {}) as DevicePairPluginConfig;
  const scheme = resolveScheme(cfg);
  const port = resolveGatewayPort(cfg);

  if (typeof pluginCfg.publicUrl === "string" && pluginCfg.publicUrl.trim()) {
    const url = normalizeUrl(pluginCfg.publicUrl, scheme);
    if (url) {
      return { url, source: "plugins.entries.device-pair.config.publicUrl" };
    }
    return { error: "Configured publicUrl is invalid." };
  }

  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
    const host = await resolveTailnetHost(api);
    if (!host) {
      return { error: "Tailscale Serve is enabled, but MagicDNS could not be resolved." };
    }
    return { url: `wss://${host}`, source: `gateway.tailscale.mode=${tailscaleMode}` };
  }

  const remoteUrl = cfg.gateway?.remote?.url;
  if (typeof remoteUrl === "string" && remoteUrl.trim()) {
    const url = normalizeUrl(remoteUrl, scheme);
    if (url) {
      return { url, source: "gateway.remote.url" };
    }
  }

  const bind = cfg.gateway?.bind ?? "loopback";
  if (bind === "custom") {
    const host = cfg.gateway?.customBindHost?.trim();
    if (host) {
      return { url: `${scheme}://${host}:${port}`, source: "gateway.bind=custom" };
    }
    return { error: "gateway.bind=custom requires gateway.customBindHost." };
  }

  if (bind === "tailnet") {
    const host = pickTailnetIPv4();
    if (host) {
      return { url: `${scheme}://${host}:${port}`, source: "gateway.bind=tailnet" };
    }
    return { error: "gateway.bind=tailnet set, but no tailnet IP was found." };
  }

  if (bind === "lan") {
    const host = pickLanIPv4();
    if (host) {
      return { url: `${scheme}://${host}:${port}`, source: "gateway.bind=lan" };
    }
    return { error: "gateway.bind=lan set, but no private LAN IP was found." };
  }

  return {
    error:
      "Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl.",
  };
}

function encodeSetupCode(payload: SetupPayload): string {
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, "utf8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function formatSetupReply(payload: SetupPayload, authLabel: string): string {
  const setupCode = encodeSetupCode(payload);
  return [
    "Pairing setup code generated.",
    "",
    "1) Open the iOS app → Settings → Gateway",
    "2) Paste the setup code below and tap Connect",
    "3) Back here, run /pair approve",
    "",
    "Setup code:",
    setupCode,
    "",
    `Gateway: ${payload.url}`,
    `Auth: ${authLabel}`,
  ].join("\n");
}

function formatSetupInstructions(): string {
  return [
    "Pairing setup code generated.",
    "",
    "1) Open the iOS app → Settings → Gateway",
    "2) Paste the setup code from my next message and tap Connect",
    "3) Back here, run /pair approve",
  ].join("\n");
}

type PendingPairingRequest = {
  requestId: string;
  deviceId: string;
  displayName?: string;
  platform?: string;
  remoteIp?: string;
  ts?: number;
};

function formatPendingRequests(pending: PendingPairingRequest[]): string {
  if (pending.length === 0) {
    return "No pending device pairing requests.";
  }
  const lines: string[] = ["Pending device pairing requests:"];
  for (const req of pending) {
    const label = req.displayName?.trim() || req.deviceId;
    const platform = req.platform?.trim();
    const ip = req.remoteIp?.trim();
    const parts = [
      `- ${req.requestId}`,
      label ? `name=${label}` : null,
      platform ? `platform=${platform}` : null,
      ip ? `ip=${ip}` : null,
    ].filter(Boolean);
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}

export default function register(api: OpenClawPluginApi) {
  api.registerCommand({
    name: "pair",
    description: "Generate setup codes and approve device pairing requests.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const tokens = args.split(/\s+/).filter(Boolean);
      const action = tokens[0]?.toLowerCase() ?? "";
      api.logger.info?.(
        `device-pair: /pair invoked channel=${ctx.channel} sender=${ctx.senderId ?? "unknown"} action=${
          action || "new"
        }`,
      );

      if (action === "status" || action === "pending") {
        const list = await listDevicePairing();
        return { text: formatPendingRequests(list.pending) };
      }

      if (action === "approve") {
        const requested = tokens[1]?.trim();
        const list = await listDevicePairing();
        if (list.pending.length === 0) {
          return { text: "No pending device pairing requests." };
        }

        let pending: (typeof list.pending)[number] | undefined;
        if (requested) {
          if (requested.toLowerCase() === "latest") {
            pending = [...list.pending].toSorted((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0];
          } else {
            pending = list.pending.find((entry) => entry.requestId === requested);
          }
        } else if (list.pending.length === 1) {
          pending = list.pending[0];
        } else {
          return {
            text:
              `${formatPendingRequests(list.pending)}\n\n` +
              "Multiple pending requests found. Approve one explicitly:\n" +
              "/pair approve <requestId>\n" +
              "Or approve the most recent:\n" +
              "/pair approve latest",
          };
        }
        if (!pending) {
          return { text: "Pairing request not found." };
        }
        const approved = await approveDevicePairing(pending.requestId);
        if (!approved) {
          return { text: "Pairing request not found." };
        }
        const label = approved.device.displayName?.trim() || approved.device.deviceId;
        const platform = approved.device.platform?.trim();
        const platformLabel = platform ? ` (${platform})` : "";
        return { text: `✅ Paired ${label}${platformLabel}.` };
      }

      const auth = resolveAuth(api.config);
      if (auth.error) {
        return { text: `Error: ${auth.error}` };
      }

      const urlResult = await resolveGatewayUrl(api);
      if (!urlResult.url) {
        return { text: `Error: ${urlResult.error ?? "Gateway URL unavailable."}` };
      }

      const payload: SetupPayload = {
        url: urlResult.url,
        token: auth.token,
        password: auth.password,
      };

      const channel = ctx.channel;
      const target = ctx.senderId?.trim() || ctx.from?.trim() || ctx.to?.trim() || "";
      const authLabel = auth.label ?? "auth";

      if (channel === "telegram" && target) {
        try {
          const runtimeKeys = Object.keys(api.runtime ?? {});
          const channelKeys = Object.keys(api.runtime?.channel ?? {});
          api.logger.debug?.(
            `device-pair: runtime keys=${runtimeKeys.join(",") || "none"} channel keys=${
              channelKeys.join(",") || "none"
            }`,
          );
          const send = api.runtime?.channel?.telegram?.sendMessageTelegram;
          if (!send) {
            throw new Error(
              `telegram runtime unavailable (runtime keys: ${runtimeKeys.join(",")}; channel keys: ${channelKeys.join(
                ",",
              )})`,
            );
          }
          await send(target, formatSetupInstructions(), {
            ...(ctx.messageThreadId != null ? { messageThreadId: ctx.messageThreadId } : {}),
            ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
          });
          api.logger.info?.(
            `device-pair: telegram split send ok target=${target} account=${ctx.accountId ?? "none"} thread=${
              ctx.messageThreadId ?? "none"
            }`,
          );
          return { text: encodeSetupCode(payload) };
        } catch (err) {
          api.logger.warn?.(
            `device-pair: telegram split send failed, falling back to single message (${String(
              (err as Error)?.message ?? err,
            )})`,
          );
        }
      }

      return {
        text: formatSetupReply(payload, authLabel),
      };
    },
  });
}
