import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACTIONS = [
  "get_pairs",
  "get_open_trades",
  "get_open_trade_metrics",
  "get_target_funding_rate",
  "get_pair_max_leverage",
  "get_pair_overnight_max_leverage",
  "get_rollover_rate",
  "get_funding_rate",
  "open_trade",
  "close_trade",
  "cancel_limit_order",
  "update_tp",
  "update_sl",
];

const WRITE_ACTIONS = new Set([
  "open_trade",
  "close_trade",
  "cancel_limit_order",
  "update_tp",
  "update_sl",
]);

const NETWORKS = ["mainnet", "testnet"];

function parseCommandJson(command: string) {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('Empty command payload. Pass JSON like {"action":"get_pairs"}.');
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("Command payload must be a JSON object.");
    }
    return parsed;
  } catch (error: any) {
    throw new Error(`Invalid command JSON: ${error?.message || String(error)}`);
  }
}

function resolveInput(params: Record<string, unknown>) {
  if (typeof params.command !== "string" || (params.action as string | undefined)?.trim()) {
    return params;
  }
  const fromCommand = parseCommandJson(params.command);
  return { ...params, ...fromCommand };
}

function getAction(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing action. Supported actions: ${ACTIONS.join(", ")}.`);
  }
  const action = value.trim();
  if (!ACTIONS.includes(action)) {
    throw new Error(`Unsupported action "${action}". Supported actions: ${ACTIONS.join(", ")}`);
  }
  return action;
}

function getDefaultRunnerPath() {
  const filePath = fileURLToPath(import.meta.url);
  const fileDir = path.dirname(filePath);
  return path.resolve(fileDir, "../scripts/ostium_runner.py");
}

function runPythonRunner(
  pythonBin: string,
  runnerPath: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [runnerPath], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: any) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to execute ${pythonBin}: ${error?.message || String(error)}`));
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutHandle);
      if (timedOut) {
        reject(new Error(`Ostium runner timed out after ${timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        const details = stderr.trim() || stdout.trim() || `exit code ${String(code)}`;
        reject(new Error(`Ostium runner failed: ${details}`));
        return;
      }
      const output = stdout.trim();
      if (!output) {
        reject(new Error("Ostium runner produced no output."));
        return;
      }
      resolve(output);
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();
  });
}

export function createOstiumTool(api: any) {
  return {
    name: "ostium",
    label: "Ostium",
    description:
      "Run Ostium SDK reads and writes (pairs, metrics, open/close/update trade) over Arbitrum.",
    parameters: {
      type: "object",
      additionalProperties: true,
      properties: {
        action: { type: "string", enum: ACTIONS },
        command: { type: "string" },
        network: { type: "string", enum: NETWORKS },
        traderAddress: { type: "string" },
        pairId: { type: "number" },
        tradeIndex: { type: "number" },
        periodHours: { type: "number" },
        includingCurrentPriceAndMarketStatus: { type: "boolean" },
        tradeParams: { type: "object", additionalProperties: true },
        atPrice: { type: "number" },
        at_price: { type: "number" },
        marketPrice: { type: "number" },
        market_price: { type: "number" },
        closePercentage: { type: "number" },
        tpPrice: { type: "number" },
        tp_price: { type: "number" },
        slPrice: { type: "number" },
        sl_price: { type: "number" },
        pair_id: { type: "number" },
        trade_index: { type: "number" },
        useDelegation: { type: "boolean" },
        verbose: { type: "boolean" },
        rpcUrl: { type: "string" },
        privateKey: { type: "string" },
        commandName: { type: "string" },
        skillName: { type: "string" },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const pluginConfig = (api.pluginConfig ?? {}) as Record<string, any>;
      const input = resolveInput(params);
      const action = getAction(input.action);

      const allowWrites = pluginConfig.allowWrites ?? true;
      if (WRITE_ACTIONS.has(action) && !allowWrites) {
        throw new Error(`Write action "${action}" is disabled by plugins.entries.ostium.config.`);
      }

      const networkValue =
        typeof input.network === "string" && input.network
          ? input.network
          : (pluginConfig.defaultNetwork ?? "mainnet");

      if (!NETWORKS.includes(networkValue)) {
        throw new Error(`Invalid network "${networkValue}". Use mainnet or testnet.`);
      }

      const rpcUrlEnvVar = pluginConfig.rpcUrlEnvVar?.trim?.() || "RPC_URL";
      const privateKeyEnvVar = pluginConfig.privateKeyEnvVar?.trim?.() || "PRIVATE_KEY";
      const pythonBin = pluginConfig.pythonBin?.trim?.() || "python3";
      const timeoutMs =
        typeof pluginConfig.timeoutMs === "number" && pluginConfig.timeoutMs > 0
          ? pluginConfig.timeoutMs
          : 120000;
      const runnerPath = pluginConfig.runnerPath?.trim?.() || getDefaultRunnerPath();

      const cfgRpcUrl =
        typeof pluginConfig.rpcUrl === "string" && pluginConfig.rpcUrl.trim()
          ? pluginConfig.rpcUrl.trim()
          : undefined;
      const cfgPrivateKey =
        typeof pluginConfig.privateKey === "string" && pluginConfig.privateKey.trim()
          ? pluginConfig.privateKey.trim()
          : undefined;

      const payload: Record<string, unknown> = {
        ...input,
        action,
        network: networkValue,
        useDelegation:
          typeof input.useDelegation === "boolean"
            ? input.useDelegation
            : (pluginConfig.useDelegation ?? false),
        rpcUrlEnvVar,
        privateKeyEnvVar,
      };

      if (typeof payload.rpcUrl !== "string" && cfgRpcUrl) {
        payload.rpcUrl = cfgRpcUrl;
      }
      if (typeof payload.privateKey !== "string" && cfgPrivateKey) {
        payload.privateKey = cfgPrivateKey;
      }

      delete payload.command;
      delete payload.commandName;
      delete payload.skillName;

      const output = await runPythonRunner(
        pythonBin,
        path.isAbsolute(runnerPath) ? runnerPath : path.resolve(runnerPath),
        payload,
        timeoutMs,
      );

      let parsed: any;
      try {
        parsed = JSON.parse(output);
      } catch (error: any) {
        throw new Error(`Ostium runner returned invalid JSON: ${error?.message || String(error)}`);
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Ostium runner returned invalid payload.");
      }

      if (parsed.ok === false) {
        throw new Error(
          `Ostium action "${action}" failed: ${parsed.error || "unknown Ostium error"}`,
        );
      }

      const text = JSON.stringify(parsed.result ?? parsed, null, 2);
      return {
        content: [{ type: "text", text }],
        details: {
          json: parsed,
          action,
          network: networkValue,
          writesEnabled: allowWrites,
        },
      };
    },
  };
}
