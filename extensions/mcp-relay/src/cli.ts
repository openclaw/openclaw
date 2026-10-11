import type { Command } from "commander";
import type { GatewayRpcOpts } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";

type CliContext = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0];
type RelayCommand = "status" | "pair" | "grants" | "revoke";

async function runCommand(
  op: RelayCommand,
  opts: GatewayRpcOpts,
  params: Record<string, unknown>,
): Promise<void> {
  const { callGatewayFromCli, redactSensitiveUrlLikeString } =
    await import("openclaw/plugin-sdk/gateway-runtime");
  try {
    const result = await callGatewayFromCli(`mcp-relay.${op}`, opts, params, {
      progress: !opts.json,
      scopes: [op === "status" ? "operator.read" : "operator.admin"],
    });
    if (opts.json) {
      defaultRuntime.writeJson(result);
      return;
    }
    if (op === "pair" && typeof result.code === "string" && typeof result.mcpUrl === "string") {
      defaultRuntime.log(`Pairing code: ${result.code}`);
      if (typeof result.expiresAt === "number") {
        defaultRuntime.log(`Expires: ${new Date(result.expiresAt).toISOString()}`);
      }
      defaultRuntime.log(`MCP URL: ${result.mcpUrl}`);
      defaultRuntime.log(
        "In ChatGPT, open Plugins and add this MCP URL; in Claude, add a custom connector. Enter this code on the OpenClaw consent page.",
      );
      return;
    }
    defaultRuntime.writeJson(result);
  } catch (error) {
    const detail = redactSensitiveUrlLikeString(
      error instanceof Error ? error.message : String(error),
    );
    const message = `${detail}\nCheck that the Gateway is running and mcp-relay is enabled with openclaw plugins enable mcp-relay, then retry.`;
    if (opts.json) {
      defaultRuntime.writeJson({ error: message });
    } else {
      defaultRuntime.error(message);
    }
    defaultRuntime.exit(1);
  }
}

export async function registerMcpRelayCli({ program }: CliContext): Promise<void> {
  const { addGatewayClientOptions } = await import("openclaw/plugin-sdk/gateway-runtime");
  const relay = program
    .command("mcp-relay")
    .description("Inspect the MCP relay connection and manage client grants");

  const command = (name: string, description: string): Command =>
    addGatewayClientOptions(relay.command(name).description(description)).option(
      "--json",
      "Emit JSON",
      false,
    );

  command("status", "Show the running Gateway's relay connection and grant count").action(
    (opts: GatewayRpcOpts) => runCommand("status", opts, {}),
  );
  command("pair", "Issue a single-use pairing code for a remote MCP client").action(
    (opts: GatewayRpcOpts) => runCommand("pair", opts, {}),
  );
  command("grants", "List the running Gateway's MCP client grants").action((opts: GatewayRpcOpts) =>
    runCommand("grants", opts, {}),
  );
  command("revoke <grantId>", "Revoke a client grant locally and notify the relay").action(
    (grantId: string, opts: GatewayRpcOpts) => runCommand("revoke", opts, { grantId }),
  );
}
