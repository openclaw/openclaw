import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import {
  connectGbrain,
  GBRAIN_SERVER_NAME,
  type ConnectDeps,
  type ConnectOutcome,
} from "./src/connect.js";
import { gbrainAcceptsToken, mintGbrainKey, readGbrainHealth } from "./src/gbrain-http.js";

const RECHECK_MS = 60_000;
/** A failed install, init or `mcp expose` is retried at most this often. */
const SETUP_RETRY_MS = 10 * 60_000;
/** Blocks found before any setup command ran; rechecked every minute. */
const CHEAP_BLOCKS: Record<string, true> = {
  "bun-missing": true,
  "container-without-gbrain": true,
  "setup-pending": true,
};
const SYSTEM_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export default definePluginEntry({
  id: "gbrain",
  name: "GBrain",
  description: "Connects OpenClaw to a GBrain brain over MCP",
  register(api) {
    let lastSetupAt: number | undefined;
    let lastReport = "";

    const home = homedir();
    const env = process.env;
    const searchPath = [
      path.join(env.BUN_INSTALL?.trim() || path.join(home, ".bun"), "bin"),
      ...(env.PATH ?? "").split(path.delimiter).filter(Boolean),
      ...SYSTEM_PATH,
    ];
    const findExecutable = (name: string, candidates: string[]) =>
      [...candidates, ...searchPath.map((dir) => path.join(dir, name))].find(isExecutable);
    // GBrain's commands get the user's session (XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS
    // decide whether GBrain can install its systemd user unit), never the Gateway's own
    // service identity or credentials.
    const childEnv: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          !key.startsWith("OPENCLAW_") && !/(TOKEN|SECRET|PASSWORD|API_KEY|_KEY)$/i.test(key),
      ),
    );
    childEnv.HOME = home;
    childEnv.PATH = [...new Set(searchPath)].join(path.delimiter);
    const inContainer = existsSync("/.dockerenv") || existsSync("/run/.containerenv");
    const deps: ConnectDeps = {
      home,
      env,
      // In Docker, GBrain runs as the `gbrain` Compose service (deploy/gbrain/compose.yaml).
      hosts: inContainer ? ["127.0.0.1", "gbrain"] : ["127.0.0.1"],
      inContainer,
      readFile: (file) => {
        try {
          return readFileSync(file, "utf8");
        } catch {
          return undefined;
        }
      },
      findExecutable,
      run: async (argv, timeoutMs) =>
        await runCommandWithTimeout(argv, { timeoutMs, env: childEnv, baseEnv: {}, cwd: home }),
      health: readGbrainHealth,
      tokenAccepted: gbrainAcceptsToken,
      mintKey: mintGbrainKey,
      readServer: () => api.runtime.config.current().mcp?.servers?.[GBRAIN_SERVER_NAME],
      writeServer: async (entry) => {
        await api.runtime.config.mutateConfigFile({
          afterWrite: { mode: "auto" },
          mutate: (draft) => {
            draft.mcp ??= {};
            draft.mcp.servers ??= {};
            draft.mcp.servers[GBRAIN_SERVER_NAME] = {
              url: entry.url,
              transport: "streamable-http",
              headers: entry.headers as Record<string, string>,
            };
          },
        });
      },
      sleep: async (ms) => await sleep(ms),
    };

    function report(
      outcome: ConnectOutcome,
      health: { reportFailure: (error: unknown) => void; clearFailure: () => void } | undefined,
    ) {
      const line =
        outcome.state === "connected"
          ? `GBrain ${outcome.version} connected as MCP server "${GBRAIN_SERVER_NAME}" (${outcome.mcpUrl})`
          : outcome.state === "external"
            ? `mcp.servers.${GBRAIN_SERVER_NAME} points at ${outcome.url}; the GBrain plugin leaves it as configured`
            : outcome.message;
      if (outcome.state === "blocked") {
        health?.reportFailure(new Error(line));
      } else {
        health?.clearFailure();
      }
      if (line !== lastReport || (outcome.state === "connected" && outcome.changed)) {
        lastReport = line;
        if (outcome.state === "blocked") {
          api.logger.warn(line);
        } else {
          api.logger.info(line);
        }
      }
    }

    api.registerService({
      apiVersion: 2,
      id: "gbrain-connection",
      start: (ctx) => {
        ctx.scheduler.schedule({
          id: "connect",
          delayMs: 0,
          everyMs: RECHECK_MS,
          run: async () => {
            const now = ctx.scheduler.now();
            const allowSetup = lastSetupAt === undefined || now - lastSetupAt >= SETUP_RETRY_MS;
            try {
              const outcome = await connectGbrain(deps, { allowSetup });
              if (outcome.state === "blocked" && allowSetup && !CHEAP_BLOCKS[outcome.reason]) {
                lastSetupAt = now;
              }
              report(outcome, ctx.serviceHealth);
            } catch (error) {
              report(
                {
                  state: "blocked",
                  reason: "error",
                  message: `GBrain connection failed: ${error instanceof Error ? error.message : String(error)}`,
                },
                ctx.serviceHealth,
              );
            }
          },
        });
      },
    });
  },
});
