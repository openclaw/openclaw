import type { Command } from "commander";
import type { NodeMatchCandidate } from "openclaw/plugin-sdk/gateway-runtime";
import {
  buildNodeInvokeParams,
  getNodesTheme,
  nodesCallOpts,
  runNodesCommand,
} from "openclaw/plugin-sdk/node-cli-runtime";
import {
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
  parseStrictFiniteNumber,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type CanvasCliRuntime = {
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
  writeJson: (value: unknown) => void;
};

export type CanvasNodesRpcOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  json?: boolean;
  node?: string;
  invokeTimeout?: string;
  target?: string;
  x?: string;
  y?: string;
  width?: string;
  height?: string;
};

export type CanvasCliDependencies = {
  defaultRuntime: CanvasCliRuntime;
  nodesCallOpts: (cmd: Command, defaults?: { timeoutMs?: number }) => Command;
  runNodesCommand: (label: string, action: () => Promise<void>) => Promise<void> | void;
  getNodesTheme: () => { ok: (value: string) => string };
  parseTimeoutMs: (raw: unknown) => number | undefined;
  resolveNodeId: (opts: CanvasNodesRpcOpts, query: string) => Promise<string>;
  buildNodeInvokeParams: (params: {
    nodeId: string;
    command: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
  }) => Record<string, unknown>;
  callGatewayCli: (
    method: string,
    opts: CanvasNodesRpcOpts,
    params?: unknown,
    callOpts?: { transportTimeoutMs?: number },
  ) => Promise<unknown>;
};

const DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS = 30_000;
const CANVAS_NODE_INVOKE_TRANSPORT_GRACE_MS = 10_000;

function parseTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined) {
    throw new Error("--invoke-timeout must be a positive integer.");
  }
  return parsed;
}

function parseCanvasFiniteNumberOption(raw: string | undefined, flag: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = parseStrictFiniteNumber(raw);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a number.`);
  }
  return parsed;
}

function parseNodeCandidates(raw: unknown): NodeMatchCandidate[] {
  const payload =
    raw && typeof raw === "object" ? (raw as { nodes?: unknown; paired?: unknown }) : {};
  const list = Array.isArray(payload.nodes)
    ? payload.nodes
    : Array.isArray(payload.paired)
      ? payload.paired
      : [];
  return list
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const node = entry as {
        nodeId?: unknown;
        displayName?: unknown;
        remoteIp?: unknown;
        connected?: unknown;
        clientId?: unknown;
      };
      if (typeof node.nodeId !== "string") {
        return null;
      }
      const candidate: NodeMatchCandidate = { nodeId: node.nodeId };
      if (typeof node.displayName === "string") {
        candidate.displayName = node.displayName;
      }
      if (typeof node.remoteIp === "string") {
        candidate.remoteIp = node.remoteIp;
      }
      if (typeof node.connected === "boolean") {
        candidate.connected = node.connected;
      }
      if (typeof node.clientId === "string") {
        candidate.clientId = node.clientId;
      }
      return candidate;
    })
    .filter((entry): entry is NodeMatchCandidate => entry !== null);
}

export function createDefaultCanvasCliDependencies(): CanvasCliDependencies {
  const callGatewayCli: CanvasCliDependencies["callGatewayCli"] = async (
    method,
    opts,
    params,
    callOpts,
  ) => {
    const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
    const timeout = String(callOpts?.transportTimeoutMs ?? opts.timeout ?? 10_000);
    return await callGatewayFromCli(method, { ...opts, timeout }, params, {
      progress: opts.json !== true,
    });
  };
  return {
    defaultRuntime,
    nodesCallOpts,
    runNodesCommand,
    getNodesTheme,
    parseTimeoutMs,
    resolveNodeId: async (opts, query) => {
      const { isGatewayClientRequestError, resolveNodeFromNodeList } =
        await import("openclaw/plugin-sdk/gateway-runtime");
      let raw: unknown;
      try {
        raw = await callGatewayCli("node.list", opts, {});
      } catch (error) {
        if (
          !isGatewayClientRequestError(error) ||
          error.gatewayCode !== "INVALID_REQUEST" ||
          error.retryable ||
          error.message !== "unknown method: node.list"
        ) {
          throw error;
        }
        raw = await callGatewayCli("node.pair.list", opts, {});
      }
      return resolveNodeFromNodeList(parseNodeCandidates(raw), query).nodeId;
    },
    buildNodeInvokeParams,
    callGatewayCli,
  };
}

async function invokeCanvas(
  deps: CanvasCliDependencies,
  opts: CanvasNodesRpcOpts,
  command: string,
  params?: Record<string, unknown>,
) {
  const timeoutMs =
    clampPositiveTimerTimeoutMs(
      deps.parseTimeoutMs(opts.invokeTimeout) ?? DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS,
    ) ?? DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS;
  const nodeId = await deps.resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
  const invokeParams = deps.buildNodeInvokeParams({ nodeId, command, params, timeoutMs });
  const configuredGatewayTimeoutMs = parseStrictPositiveInteger(opts.timeout ?? 10_000);
  if (configuredGatewayTimeoutMs === undefined) {
    // Preserve the existing Gateway parser's actionable invalid --timeout error.
    return await deps.callGatewayCli("node.invoke", opts, invokeParams);
  }
  // Node work owns its deadline; Gateway transport needs extra time to deliver that result.
  const transportTimeoutMs = Math.max(
    clampPositiveTimerTimeoutMs(configuredGatewayTimeoutMs) ??
      DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS,
    addTimerTimeoutGraceMs(timeoutMs, CANVAS_NODE_INVOKE_TRANSPORT_GRACE_MS) ?? timeoutMs,
  );
  return await deps.callGatewayCli("node.invoke", opts, invokeParams, { transportTimeoutMs });
}

async function runCanvasCommand(
  deps: CanvasCliDependencies,
  opts: CanvasNodesRpcOpts,
  action: "present" | "hide" | "navigate",
  params?: () => Record<string, unknown>,
): Promise<void> {
  await deps.runNodesCommand(`canvas ${action}`, async () => {
    const result = await invokeCanvas(deps, opts, `canvas.${action}`, params?.());
    if (opts.json) {
      deps.defaultRuntime.writeJson(result);
    } else {
      const { ok } = deps.getNodesTheme();
      deps.defaultRuntime.log(ok(`canvas ${action} ok`));
    }
  });
}

export function registerNodesCanvasCommands(nodes: Command, deps: CanvasCliDependencies) {
  const canvas = nodes
    .command("canvas")
    .description("Present widget documents on a paired macOS panel");

  deps.nodesCallOpts(
    canvas
      .command("present")
      .description("Show the canvas (optionally with a target URL/path)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--target <urlOrPath>", "Target URL/path (optional)")
      .option("--x <px>", "Placement x coordinate")
      .option("--y <px>", "Placement y coordinate")
      .option("--width <px>", "Placement width")
      .option("--height <px>", "Placement height")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action((opts: CanvasNodesRpcOpts) =>
        runCanvasCommand(deps, opts, "present", () => {
          const placement = {
            x: parseCanvasFiniteNumberOption(opts.x, "--x"),
            y: parseCanvasFiniteNumberOption(opts.y, "--y"),
            width: parseCanvasFiniteNumberOption(opts.width, "--width"),
            height: parseCanvasFiniteNumberOption(opts.height, "--height"),
          };
          const params: Record<string, unknown> = {};
          if (opts.target) {
            params.url = opts.target;
          }
          if (Object.values(placement).some(Number.isFinite)) {
            params.placement = placement;
          }
          return params;
        }),
      ),
  );

  deps.nodesCallOpts(
    canvas
      .command("hide")
      .description("Hide the canvas")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action((opts: CanvasNodesRpcOpts) => runCanvasCommand(deps, opts, "hide")),
  );

  deps.nodesCallOpts(
    canvas
      .command("navigate")
      .description("Navigate the canvas to a URL")
      .argument("<url>", "Target URL/path")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action((url: string, opts: CanvasNodesRpcOpts) =>
        runCanvasCommand(deps, opts, "navigate", () => ({ url })),
      ),
  );
}
