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
            // Very simple mock for help
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                stdout:
                  "OpenClaw-Tool CLI\n\nUsage: openclaw-tool <command>\n\nCommands:\n  agents list\n  sessions list\n\n(Schema dynamically updated in background)",
                exitCode: 0,
              }),
            );
            return;
          }

          const cmd = resolveCommand(args);
          if (!cmd) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                stderr: `Unknown command: openclaw-tool ${args.join(" ")}\n`,
                exitCode: 1,
              }),
            );
            return;
          }

          // Instantiate the tool
          const tool = cmd.toolDef.factory({ agentSessionKey: sessionKey });
          const toolParams = cmd.toolDef.parseArgs(cmd.commandArgs);

          // Execute
          const result = await tool.execute(toolParams);

          // Result formatting
          let stdout = "";
          if (result.type === "json") {
            stdout = JSON.stringify(result.data, null, 2) + "\n";
          } else if (result.type === "text") {
            stdout = result.text + "\n";
          } else {
            stdout = "Command executed successfully.\n";
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

  server.listen(PORT, "127.0.0.1", () => {
    logInfo(`OpenClaw-Tool RPC Daemon listening on port ${PORT}`);
  });
}
