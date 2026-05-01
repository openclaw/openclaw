import path from "node:path";
import type { AcpRuntimeEvent, OpenClawPluginApi } from "openclaw/plugin-sdk/acpx";
import {
  buildCodexEnabledConfig,
  getCodexController,
  parseExportFormat,
  parseLimit,
  splitArgs,
  type JsonOption,
  type LimitOption,
} from "./commands-shared.js";
import {
  CODEX_SDK_BACKEND_ID,
  resolveCodexRouteForId,
  resolveCodexSdkPluginConfig,
} from "./config.js";
import {
  formatCodexEvents,
  formatCodexInbox,
  formatCodexRoutes,
  formatCodexSessions,
  formatCodexStatus,
  formatCompatibilityRecord,
  formatProposalExecution,
  formatProposalUpdate,
} from "./format.js";

export {
  buildCodexEnabledConfig,
  getCodexController,
  getCodexControllerContext,
} from "./commands-shared.js";
export { formatCodexRoutes } from "./format.js";
export { registerCodexGatewayMethods } from "./gateway-methods.js";

const CODEX_HELP = [
  "Codex SDK commands:",
  "- /codex status",
  "- /codex routes",
  "- /codex sessions [limit]",
  "- /codex events <session-key> [limit]",
  "- /codex export <session-key> [markdown|json]",
  "- /codex inbox [limit]",
  "- /codex accept <proposal-id>",
  "- /codex dismiss <proposal-id>",
  "- /codex execute <proposal-id> [route]",
  "- /codex doctor",
].join("\n");

export function registerCodexNativeCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "codex",
    description: "Inspect and manage the native Codex SDK runtime.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const tokens = splitArgs(ctx.args ?? "");
      const action = tokens[0]?.toLowerCase() ?? "status";
      const controller = getCodexController(api);

      if (action === "help") {
        return { text: CODEX_HELP };
      }
      if (action === "status" || action === "") {
        return { text: formatCodexStatus(await controller.status()) };
      }
      if (action === "routes") {
        return { text: formatCodexRoutes(controller.listRoutes()) };
      }
      if (action === "sessions") {
        const limit = parseLimit(tokens[1], 10);
        return { text: formatCodexSessions(await controller.listSessions(limit)) };
      }
      if (action === "events") {
        const sessionKey = tokens[1];
        if (!sessionKey) {
          return { text: "Usage: /codex events <session-key> [limit]" };
        }
        const limit = parseLimit(tokens[2], 30);
        return { text: formatCodexEvents(await controller.listEvents(sessionKey, limit)) };
      }
      if (action === "export") {
        const sessionKey = tokens[1];
        if (!sessionKey) {
          return { text: "Usage: /codex export <session-key> [markdown|json]" };
        }
        const exported = await controller.exportSession(sessionKey, {
          format: parseExportFormat(tokens[2]),
        });
        return { text: exported.text };
      }
      if (action === "inbox") {
        const limit = parseLimit(tokens[1], 10);
        return { text: formatCodexInbox(await controller.listInbox(limit)) };
      }
      if (action === "accept" || action === "dismiss") {
        const id = tokens[1];
        if (!id) {
          return { text: `Usage: /codex ${action} <proposal-id>` };
        }
        const status = action === "accept" ? "accepted" : "dismissed";
        const updated = await controller.updateInbox(id, status);
        return {
          text: updated
            ? `Codex proposal ${updated.id} marked ${updated.status}: ${updated.title}`
            : `Codex proposal not found: ${id}`,
        };
      }
      if (action === "execute") {
        const id = tokens[1];
        if (!id) {
          return { text: "Usage: /codex execute <proposal-id> [route]" };
        }
        return {
          text: formatProposalExecution(
            await controller.executeProposal(id, {
              ...(tokens[2] ? { route: tokens[2] } : {}),
            }),
          ),
        };
      }
      if (action === "doctor") {
        return { text: formatCompatibilityRecord(await controller.doctor(true)) };
      }

      return { text: `Unknown Codex command: ${action}\n\n${CODEX_HELP}` };
    },
  });
}

export function registerCodexCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program, workspaceDir }) => {
      const codex = program
        .command("codex")
        .description("Inspect, configure, and run OpenClaw's native Codex SDK runtime");

      codex
        .command("status")
        .description("Show Codex SDK runtime status")
        .option("--json", "print JSON")
        .action(async (opts: JsonOption) => {
          const controller = getCodexController(api, workspaceDir);
          await printResult(await controller.status(), opts, formatCodexStatus);
        });

      codex
        .command("routes")
        .description("List configured Codex routes")
        .option("--json", "print JSON")
        .action(async (opts: JsonOption) => {
          const controller = getCodexController(api, workspaceDir);
          const routes = controller.listRoutes();
          await printResult(routes, opts, formatCodexRoutes);
        });

      codex
        .command("sessions")
        .description("List recent Codex sessions")
        .option("--limit <n>", "maximum sessions to show", "20")
        .option("--json", "print JSON")
        .action(async (opts: JsonOption & LimitOption) => {
          const controller = getCodexController(api, workspaceDir);
          const sessions = await controller.listSessions(parseLimit(opts.limit, 20));
          await printResult(sessions, opts, formatCodexSessions);
        });

      codex
        .command("events <sessionKey>")
        .description("Replay recorded Codex SDK events for a session")
        .option("--limit <n>", "maximum events to show", "80")
        .option("--json", "print JSON")
        .action(async (sessionKey: string, opts: JsonOption & LimitOption) => {
          const controller = getCodexController(api, workspaceDir);
          const events = await controller.listEvents(sessionKey, parseLimit(opts.limit, 80));
          await printResult(events, opts, formatCodexEvents);
        });

      codex
        .command("export <sessionKey>")
        .description("Export a recorded Codex SDK session")
        .option("--format <format>", "markdown or json", "markdown")
        .option("--limit <n>", "maximum events to include", "400")
        .option("--json", "print JSON metadata instead of export text")
        .action(
          async (sessionKey: string, opts: JsonOption & LimitOption & { format?: string }) => {
            const controller = getCodexController(api, workspaceDir);
            const exported = await controller.exportSession(sessionKey, {
              format: parseExportFormat(opts.format),
              limit: parseLimit(opts.limit, 400, 1000),
            });
            if (opts.json) {
              console.log(JSON.stringify(exported, null, 2));
              return;
            }
            console.log(exported.text);
          },
        );

      const inbox = codex.command("inbox").description("Manage Codex openclaw-proposal inbox");
      inbox
        .command("list")
        .description("List Codex proposals")
        .option("--limit <n>", "maximum proposals to show", "20")
        .option("--json", "print JSON")
        .action(async (opts: JsonOption & LimitOption) => {
          const controller = getCodexController(api, workspaceDir);
          const proposals = await controller.listInbox(parseLimit(opts.limit, 20));
          await printResult(proposals, opts, formatCodexInbox);
        });
      inbox
        .command("accept <id>")
        .description("Mark a Codex proposal accepted")
        .option("--json", "print JSON")
        .action(async (id: string, opts: JsonOption) => {
          const controller = getCodexController(api, workspaceDir);
          const proposal = await controller.updateInbox(id, "accepted");
          await printResult(proposal, opts, formatProposalUpdate);
        });
      inbox
        .command("dismiss <id>")
        .description("Mark a Codex proposal dismissed")
        .option("--json", "print JSON")
        .action(async (id: string, opts: JsonOption) => {
          const controller = getCodexController(api, workspaceDir);
          const proposal = await controller.updateInbox(id, "dismissed");
          await printResult(proposal, opts, formatProposalUpdate);
        });
      inbox
        .command("execute <id>")
        .description("Execute a Codex proposal with the native SDK runtime")
        .option("--route <route>", "Codex route id or label")
        .option("--cwd <dir>", "working directory")
        .option("--session-key <sessionKey>", "explicit execution session key")
        .option("--mode <mode>", "oneshot or persistent", "oneshot")
        .option("--json", "print JSON")
        .action(
          async (
            id: string,
            opts: JsonOption & {
              route?: string;
              cwd?: string;
              sessionKey?: string;
              mode?: string;
            },
          ) => {
            const controller = getCodexController(api, workspaceDir);
            const result = await controller.executeProposal(id, {
              ...(opts.route ? { route: opts.route } : {}),
              ...(opts.cwd ? { cwd: path.resolve(opts.cwd) } : {}),
              ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
              ...(opts.mode === "persistent" || opts.mode === "oneshot" ? { mode: opts.mode } : {}),
            });
            await printResult(result, opts, formatProposalExecution);
          },
        );

      codex
        .command("doctor")
        .description("Run Codex SDK compatibility checks")
        .option("--record", "write a compatibility record")
        .option("--json", "print JSON")
        .action(async (opts: JsonOption & { record?: boolean }) => {
          const controller = getCodexController(api, workspaceDir);
          const record = await controller.doctor(opts.record === true);
          await printResult(record, opts, formatCompatibilityRecord);
          if (!record.ok) {
            process.exitCode = 1;
          }
        });

      codex
        .command("config")
        .description("Validate or write Codex SDK OpenClaw config")
        .command("validate")
        .description("Validate current Codex SDK plugin config")
        .option("--json", "print JSON")
        .action(async (opts: JsonOption) => {
          const config = resolveCodexSdkPluginConfig({
            rawConfig: api.pluginConfig,
            workspaceDir,
          });
          await printResult({ ok: true, config }, opts, () =>
            [
              "Codex SDK plugin config is valid.",
              `Default route: ${resolveCodexRouteForId(config.defaultRoute, config).label}`,
              `Allowed agents: ${config.allowedAgents.join(", ")}`,
            ].join("\n"),
          );
        });

      codex
        .command("configure")
        .description("Enable Codex SDK as OpenClaw's ACP runtime backend")
        .option("--json", "print JSON")
        .action(async (opts: JsonOption) => {
          const current = api.runtime.config.loadConfig();
          const pluginConfig = resolveCodexSdkPluginConfig({
            rawConfig: api.pluginConfig,
            workspaceDir,
          });
          const next = buildCodexEnabledConfig(current, pluginConfig);
          await api.runtime.config.writeConfigFile(next);
          await printResult(
            {
              backend: CODEX_SDK_BACKEND_ID,
              defaultAgent: pluginConfig.allowedAgents.includes("codex")
                ? "codex"
                : pluginConfig.allowedAgents[0],
              allowedAgents: pluginConfig.allowedAgents,
            },
            opts,
            () =>
              [
                "Codex SDK ACP backend configured.",
                `Backend: ${CODEX_SDK_BACKEND_ID}`,
                `Allowed agents: ${pluginConfig.allowedAgents.join(", ")}`,
                "Restart the gateway to reload plugin service wiring.",
              ].join("\n"),
          );
        });

      codex
        .command("run <prompt...>")
        .description("Run a one-shot Codex SDK turn through the OpenClaw runtime adapter")
        .option("--route <route>", "Codex route id or label", "default")
        .option("--cwd <dir>", "working directory")
        .option("--json", "print JSON events")
        .action(
          async (promptParts: string[], opts: JsonOption & { route?: string; cwd?: string }) => {
            const controller = getCodexController(api, workspaceDir);
            const route = resolveCodexRouteForId(opts.route, controller.config);
            const handle = await controller.runtime.ensureSession({
              sessionKey: `cli:codex:${Date.now()}`,
              agent: route.aliases[0] ?? "codex",
              mode: "oneshot",
              cwd: opts.cwd ? path.resolve(opts.cwd) : workspaceDir,
            });
            const events: AcpRuntimeEvent[] = [];
            for await (const event of controller.runtime.runTurn({
              handle,
              text: promptParts.join(" "),
              mode: "prompt",
              requestId: `cli:${Date.now()}`,
            })) {
              events.push(event);
              if (!opts.json) {
                writeRuntimeEvent(event);
              }
            }
            if (opts.json) {
              console.log(JSON.stringify(events, null, 2));
            }
          },
        );
    },
    { commands: ["codex"] },
  );
}

async function printResult<T>(
  value: T,
  opts: JsonOption,
  formatter: (value: T) => string,
): Promise<void> {
  if (opts.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(formatter(value));
}

function writeRuntimeEvent(event: AcpRuntimeEvent): void {
  if (event.type === "text_delta" || event.type === "status" || event.type === "tool_call") {
    console.log(event.text);
    return;
  }
  if (event.type === "error") {
    console.error(event.message);
  }
}
