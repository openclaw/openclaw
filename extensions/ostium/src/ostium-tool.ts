import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

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
] as const;

const WRITE_ACTIONS = new Set<string>([
  "open_trade",
  "close_trade",
  "cancel_limit_order",
  "update_tp",
  "update_sl",
]);

const NETWORKS = ["mainnet", "testnet"] as const;

type OstiumPluginConfig = {
  allowWrites?: boolean;
  defaultNetwork?: "mainnet" | "testnet";
  pythonBin?: string;
  runnerPath?: string;
  timeoutMs?: number;
  rpcUrlEnvVar?: string;
  privateKeyEnvVar?: string;
  useDelegation?: boolean;
};

function parseCommandJson(command: string): Record<string, unknown> {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('Empty command payload. Pass JSON like {"action":"get_pairs"}.');
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("Command payload must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid command JSON: ${message}`);
  }
}

function resolveInput(params: Record<string, unknown>): Record<string, unknown> {
  if (typeof params.command !== "string" || (params.action as string | undefined)?.trim()) {
    return params;
  }
  const fromCommand = parseCommandJson(params.command);
  return { ...params, ...fromCommand };
}

function getAction(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `Missing action. Supported actions: ${ACTIONS.join(", ")}. You can also pass command JSON.`,
    );
  }
  const action = value.trim();
  if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
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

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to execute ${pythonBin}: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (timedOut) {
        reject(new Error(`Ostium runner timed out after ${timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        const stderrText = stderr.trim();
        const stdoutText = stdout.trim();
        const details = stderrText || stdoutText || `exit code ${String(code)}`;
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

export function createOstiumTool(api: OpenClawPluginApi) {
  const actionSchema = Type.Unsafe<string>({
    type: "string",
    enum: [...ACTIONS],
    description: "Ostium action to execute.",
  });

  const networkSchema = Type.Unsafe<string>({
    type: "string",
    enum: [...NETWORKS],
    description: "Target Ostium network.",
  });

  return {
    name: "ostium",
    label: "Ostium",
    description:
      "Run Ostium SDK reads and writes (pairs, metrics, open/close/update trade) over Arbitrum.",
    parameters: Type.Object(
      {
        action: Type.Optional(actionSchema),
        command: Type.Optional(
          Type.String({
            description:
              'Optional raw command payload for slash dispatch. Provide JSON, for example: {"action":"get_pairs"}.',
          }),
        ),
        network: Type.Optional(networkSchema),
        traderAddress: Type.Optional(Type.String()),
        pairId: Type.Optional(Type.Number()),
        tradeIndex: Type.Optional(Type.Number()),
        periodHours: Type.Optional(Type.Number()),
        includingCurrentPriceAndMarketStatus: Type.Optional(Type.Boolean()),
        tradeParams: Type.Optional(
          Type.Object(
            {},
            {
              additionalProperties: true,
              description: "Trade parameter object passed to SDK open_trade call.",
            },
          ),
        ),
        atPrice: Type.Optional(Type.Number()),
        marketPrice: Type.Optional(Type.Number()),
        closePercentage: Type.Optional(Type.Number()),
        tpPrice: Type.Optional(Type.Number()),
        slPrice: Type.Optional(Type.Number()),
        useDelegation: Type.Optional(Type.Boolean()),
        verbose: Type.Optional(Type.Boolean()),
        rpcUrl: Type.Optional(Type.String()),
        privateKey: Type.Optional(Type.String()),
        commandName: Type.Optional(Type.String()),
        skillName: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),

    async execute(_id: string, params: Record<string, unknown>) {
      const pluginConfig = (api.pluginConfig ?? {}) as OstiumPluginConfig;
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

      if (!NETWORKS.includes(networkValue as (typeof NETWORKS)[number])) {
        throw new Error(`Invalid network "${networkValue}". Use mainnet or testnet.`);
      }

      const rpcUrlEnvVar =
        typeof pluginConfig.rpcUrlEnvVar === "string" && pluginConfig.rpcUrlEnvVar.trim()
          ? pluginConfig.rpcUrlEnvVar.trim()
          : "RPC_URL";
      const privateKeyEnvVar =
        typeof pluginConfig.privateKeyEnvVar === "string" && pluginConfig.privateKeyEnvVar.trim()
          ? pluginConfig.privateKeyEnvVar.trim()
          : "PRIVATE_KEY";
      const pythonBin =
        typeof pluginConfig.pythonBin === "string" && pluginConfig.pythonBin.trim()
          ? pluginConfig.pythonBin.trim()
          : "python3";
      const timeoutMs =
        typeof pluginConfig.timeoutMs === "number" && pluginConfig.timeoutMs > 0
          ? pluginConfig.timeoutMs
          : 120_000;
      const runnerPath =
        typeof pluginConfig.runnerPath === "string" && pluginConfig.runnerPath.trim()
          ? pluginConfig.runnerPath.trim()
          : getDefaultRunnerPath();

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

      delete payload.command;
      delete payload.commandName;
      delete payload.skillName;

      const output = await runPythonRunner(
        pythonBin,
        path.isAbsolute(runnerPath) ? runnerPath : path.resolve(runnerPath),
        payload,
        timeoutMs,
      );

      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Ostium runner returned invalid JSON: ${message}`);
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Ostium runner returned invalid payload.");
      }

      const parsedRecord = parsed as Record<string, unknown>;
      const ok = parsedRecord.ok;
      if (ok === false) {
        const errorText =
          typeof parsedRecord.error === "string" ? parsedRecord.error : "unknown Ostium error";
        throw new Error(`Ostium action "${action}" failed: ${errorText}`);
      }

      const text = JSON.stringify(parsedRecord.result ?? parsedRecord, null, 2);
      return {
        content: [{ type: "text", text }],
        details: {
          json: parsedRecord,
          action,
          network: networkValue,
          writesEnabled: allowWrites,
        },
      };
    },
  };
}
