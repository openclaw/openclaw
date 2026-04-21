import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type JanetTtsPluginConfig = {
  publicUrl?: string;
  webSocketPath?: string;
};

type CommanderLike = {
  command(name: string): CommanderCommandLike;
};

type CommanderCommandLike = {
  command(name: string): CommanderCommandLike;
  description(text: string): CommanderCommandLike;
  option(flags: string, description?: string, defaultValue?: string): CommanderCommandLike;
  action(handler: (options: Record<string, unknown>) => void | Promise<void>): CommanderCommandLike;
};

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveGatewayToken(api: OpenClawPluginApi, explicitToken: unknown): string | null {
  return (
    normalizeOptionalString(explicitToken) ??
    normalizeOptionalString(process.env.OPENCLAW_GATEWAY_TOKEN) ??
    normalizeOptionalString(api.config.gateway?.auth?.token) ??
    null
  );
}

function resolveGatewayUrl(api: OpenClawPluginApi, explicitUrl: unknown): string | null {
  const pluginCfg = (api.pluginConfig ?? {}) as JanetTtsPluginConfig;
  return (
    normalizeOptionalString(explicitUrl) ??
    normalizeOptionalString(pluginCfg.publicUrl) ??
    normalizeOptionalString(api.config.gateway?.remote?.url) ??
    null
  );
}

function resolveWebSocketPath(api: OpenClawPluginApi, explicitPath: unknown): string {
  const pluginCfg = (api.pluginConfig ?? {}) as JanetTtsPluginConfig;
  return (
    normalizeOptionalString(explicitPath) ??
    normalizeOptionalString(pluginCfg.webSocketPath) ??
    "/ws"
  );
}

function buildConfigLink(params: { serverUrl: string; token: string; wsPath: string }): string {
  const url = new URL("janet://config");
  url.searchParams.set("server", params.serverUrl);
  url.searchParams.set("token", params.token);
  url.searchParams.set("wsPath", params.wsPath);
  return url.toString();
}

export function registerJanetCli(program: CommanderLike, api: OpenClawPluginApi): void {
  const janet = program.command("janet").description("Generate Janet config links and QR codes");

  janet
    .command("config")
    .description("Print a Janet config link and terminal QR code")
    .option("--server-url <url>", "Gateway base URL to embed in the config link")
    .option("--token <token>", "Gateway token to embed in the config link")
    .option("--ws-path <path>", "WebSocket path or port to embed in the config link")
    .option("--no-qr", "Skip the terminal QR output")
    .option("--json", "Print the JSON QR payload too")
    .action(async (options: Record<string, unknown>) => {
      const serverUrl = resolveGatewayUrl(api, options.serverUrl);
      if (!serverUrl) {
        throw new Error(
          "Janet config needs a public gateway URL. Pass --server-url or set plugins.entries.janet-tts-stream.config.publicUrl.",
        );
      }

      const token = resolveGatewayToken(api, options.token);
      if (!token) {
        throw new Error(
          "Janet config needs a gateway token. Pass --token or set OPENCLAW_GATEWAY_TOKEN / gateway.auth.token.",
        );
      }

      const wsPath = resolveWebSocketPath(api, options.wsPath);
      const link = buildConfigLink({ serverUrl, token, wsPath });
      const jsonPayload = JSON.stringify(
        {
          gatewayURL: serverUrl,
          token,
          wsPath,
        },
        null,
        2,
      );

      process.stdout.write(`Janet config link:\n\n${link}\n\n`);
      if (options.json) {
        process.stdout.write(`Janet QR JSON payload:\n\n${jsonPayload}\n\n`);
      }
      process.stdout.write(
        "On iPhone, open the link directly or scan the QR code from Janet onboarding or Settings.\n",
      );

      if (options.qr !== false) {
        const qrcodeTerminal = (await import("qrcode-terminal")).default;
        process.stdout.write("\nScan this QR from the Janet iPhone app:\n\n");
        qrcodeTerminal.generate(link, { small: true });
      }
    });
}
