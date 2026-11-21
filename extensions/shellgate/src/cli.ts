import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { SHELLGATE_CADDY_SNIPPET } from "./caddy.js";

type CliContext = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0];

export function registerShellgateCli({ program }: CliContext) {
  const shellgate = program.command("shellgate").description("Manage proxy Bearer credentials");
  shellgate
    .command("caddy")
    .description("Print a Caddy drop-in; does not change configuration")
    .action(() => {
      process.stdout.write(SHELLGATE_CADDY_SNIPPET);
    });
  const call = async (action: string, params: Record<string, string>, options: GatewayRpcOpts) => {
    const result = await callGatewayFromCli(`shellgate.credentials.${action}`, options, params, {
      scopes: ["operator.admin"],
      progress: false,
    });
    // issue/rotate deliberately deliver the token once to the invoking administrator.
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  };
  addGatewayClientOptions(
    shellgate.command("issue <subject>").description("Issue a proxy token; shown once"),
  ).action(async (subject: string, options: GatewayRpcOpts) => call("issue", { subject }, options));
  addGatewayClientOptions(
    shellgate.command("list").description("List credentials without secrets"),
  ).action(async (options: GatewayRpcOpts) => call("list", {}, options));
  addGatewayClientOptions(
    shellgate.command("rotate <id>").description("Replace a token; shown once"),
  ).action(async (id: string, options: GatewayRpcOpts) => call("rotate", { id }, options));
  addGatewayClientOptions(
    shellgate.command("revoke <id>").description("Revoke a token for future proxy authentication"),
  ).action(async (id: string, options: GatewayRpcOpts) => call("revoke", { id }, options));
}
