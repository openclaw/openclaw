import http from "node:http";
import { logInfo, logError } from "../../logger.js";
import { resolveCommand } from "./registry.js";

const PORT = 34567; // Fixed port for prototyping
let server: http.Server | null = null;

export function startRpcDaemon() {
  if (server) {
    return;
  } // Already running

  server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/rpc/openclaw-tool") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const sessionKey = req.headers["x-openclaw-session"] as string;

          const args = payload.args || [];
          // Handle --help injection later. For now, execute.

          if (args.includes("--help") || args.includes("-h")) {
            // First check if this is asking for help for a specific command (e.g. openclaw-tool feishu --help)
            const baseArgs = args.filter((a: string) => a !== "--help" && a !== "-h");
            if (baseArgs.length > 0) {
              const { getCustomMapper, macroMappers } = require("./registry.js");
              const macro = macroMappers.get(baseArgs[0]);

              if (macro) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    stdout: macro.generateHelp(),
                    exitCode: 0,
                  }),
                );
                return;
              }

              const cmd = resolveCommand(sessionKey, baseArgs);
              if (cmd) {
                const cliKey = baseArgs.slice(0, 2).join(" "); // simplistic assumption for now
                const mapper = getCustomMapper(cliKey) || getCustomMapper(baseArgs[0]);

                let helpResult = "";
                if (mapper && mapper.generateHelp) {
                  helpResult = mapper.generateHelp(cmd.tool, cliKey);
                } else {
                  const { defaultGenericHelp } = require("./mappers/types.js");
                  helpResult = defaultGenericHelp(cmd.tool, baseArgs.join(" "));
                }

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    stdout: helpResult,
                    exitCode: 0,
                  }),
                );
                return;
              }
            }

            // Fallback to top-level dynamic help
            const { getStashedTools } = require("./registry.js");
            const toolMap = getStashedTools(sessionKey);
            let dynamicList = "";
            if (toolMap) {
              const uniqueKeys = new Set<string>();
              for (const [cliKey] of toolMap.entries()) {
                if (cliKey.includes("_")) {
                  continue; // Skip original names
                }
                uniqueKeys.add(cliKey);
              }
              const sorted = Array.from(uniqueKeys).toSorted();
              dynamicList = sorted.map((k) => `  ${k.padEnd(20)} - Tool command`).join("\n");
            }

            const helpText = `OpenClaw-Tool (Agent CLI Interface)

Usage: openclaw-tool <command> [subcommand] [options]

Available Commands in Current Context:
${dynamicList || "  (No tools registered in this context)"}

Type 'openclaw-tool <command> --help' to see specific parameters.
`;

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                stdout: helpText,
                exitCode: 0,
              }),
            );
            return;
          }

          const cmd = resolveCommand(sessionKey, args);
          if (!cmd) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                stderr: `Unknown command: openclaw-tool ${args.join(" ")}\n(Make sure the tool is available in your current agent context)\n`,
                exitCode: 1,
              }),
            );
            return;
          }

          // The tool is already instantiated for this session
          const tool = cmd.tool;
          const toolParams = cmd.commandArgs;

          // Merge stdin if it exists (assuming the tool takes a "content" or "text" param, this is naive but works for some)
          if (
            payload.stdin &&
            typeof payload.stdin === "string" &&
            payload.stdin.trim().length > 0
          ) {
            toolParams["content"] = payload.stdin;
          }

          // Execute (toolCallId is arbitrary for our CLI)
          const result = await tool.execute("cli-runner", toolParams, undefined, undefined);

          // Result formatting
          let stdout = "";
          if (
            result &&
            typeof result === "object" &&
            "content" in result &&
            Array.isArray(result.content)
          ) {
            const textParts = result.content
              .filter(
                (c: unknown) =>
                  typeof c === "object" && c !== null && "type" in c && c.type === "text",
              )
              .map((c: unknown) => (c as { text: string }).text);
            stdout = textParts.join("\n") + "\n";
          } else {
            stdout = JSON.stringify(result, null, 2) + "\n";
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              stdout,
              exitCode: 0,
            }),
          );
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logError(`RPC Daemon error: ${errorMsg}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              stderr: `Internal tool error: ${errorMsg}\n`,
              exitCode: 1,
            }),
          );
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      logInfo(
        `OpenClaw-Tool RPC Daemon port ${PORT} is already in use. Assuming daemon is already running.`,
      );
    } else {
      logError(`OpenClaw-Tool RPC Daemon error: ${e.message}`);
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    logInfo(`OpenClaw-Tool RPC Daemon listening on port ${PORT} (0.0.0.0)`);
  });
}
