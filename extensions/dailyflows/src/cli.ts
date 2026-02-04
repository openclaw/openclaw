import type { Command } from "commander";
import qrcode from "qrcode-terminal";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { normalizeGatewayUrl } from "./pairing.js";

const DEFAULT_GATEWAY_PORT = 18789;

function resolveLocalGatewayUrl(config: OpenClawConfig, override?: string) {
  if (override?.trim()) {
    return override.trim();
  }
  const port = typeof config.gateway?.port === "number" ? config.gateway.port : DEFAULT_GATEWAY_PORT;
  return `http://127.0.0.1:${port}`;
}

export function registerDailyflowsCli(params: {
  program: Command;
  config: OpenClawConfig;
}) {
  const { program, config } = params;

  const root = program
    .command("dailyflows")
    .description("Dailyflows pairing helpers")
    .addHelpText("after", () => "\nDocs: https://docs.openclaw.ai/channels/dailyflows\n");

  root
    .command("pair")
    .description("Generate a Dailyflows pairing QR from the running gateway")
    .requiredOption("--gateway-url <url>", "Public HTTPS gateway URL (Tailscale Funnel)")
    .option("--account <id>", "Dailyflows account id", "default")
    .option("--gateway-http <url>", "Local gateway HTTP base URL")
    .option("--json", "Print JSON only")
    .action(async (options: { gatewayUrl: string; account: string; gatewayHttp?: string; json?: boolean }) => {
      const publicUrl = normalizeGatewayUrl(options.gatewayUrl);
      if (!publicUrl) {
        throw new Error("--gateway-url must be a public https:// URL (Tailscale Funnel)");
      }

      const localGateway = resolveLocalGatewayUrl(config, options.gatewayHttp);
      const pairingUrl = new URL("/dailyflows/pair", localGateway);
      pairingUrl.searchParams.set("gatewayUrl", publicUrl);
      pairingUrl.searchParams.set("accountId", options.account);
      pairingUrl.searchParams.set("format", "json");

      const res = await fetch(pairingUrl.toString());
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gateway pairing endpoint failed: ${res.status} ${res.statusText} ${text}`);
      }
      const payload = (await res.json()) as {
        ok?: boolean;
        error?: string;
        gatewayUrl?: string;
        accountId?: string;
        pairCode?: string;
        payload?: string;
        expiresAt?: number;
      };

      if (!payload.ok || !payload.payload) {
        throw new Error(payload.error || "Failed to generate pairing payload");
      }

      if (options.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      qrcode.generate(payload.payload, { small: true });
      // eslint-disable-next-line no-console
      console.log("\nDailyflows pairing payload:");
      // eslint-disable-next-line no-console
      console.log(payload.payload);
      // eslint-disable-next-line no-console
      console.log(`\nGateway URL: ${payload.gatewayUrl}`);
      // eslint-disable-next-line no-console
      console.log(`Pair code: ${payload.pairCode}`);
    });
}
