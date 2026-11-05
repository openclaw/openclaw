import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import type {
  ComputerUseCapabilityDescriptor,
  ComputerUseV2ActionName,
} from "../plugins/computer-use-contract.js";
import {
  COMPUTER_USE_V1_ACTION_NAMES,
  COMPUTER_USE_V2_ACTION_NAMES,
} from "../plugins/computer-use-contract.js";
import {
  loadGatewayComputerStatus,
  type GatewayComputerStatus,
} from "./tools/computer-tool-gateway.js";
import {
  COMPUTER_ACT_COMMAND,
  type ComputerToolTransport,
  SCREEN_SNAPSHOT_COMMAND,
} from "./tools/computer-tool-shared.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { shouldUseInProcessGatewayTool } from "./tools/gateway.js";
import { listNodes, type NodeListNode } from "./tools/nodes-utils.js";

export type PreparedPairedComputerUse = {
  actions: readonly ComputerUseV2ActionName[];
  guidanceCapabilities?: ComputerUseCapabilityDescriptor;
  gateway?: GatewayComputerStatus;
};

export type PairedComputerUseAvailability = {
  cacheKey: string;
  prepared?: PreparedPairedComputerUse;
};

async function readLocalComputerNodes(context: GatewayRequestContext | undefined) {
  if (!context) {
    throw new Error("Gateway context is no longer available");
  }
  const { readKnownNodeCatalog } = await import("../gateway/node-catalog-read.js");
  return (await readKnownNodeCatalog(context.nodeRegistry)).nodes;
}

async function readLocalComputerStatus(
  context: GatewayRequestContext | undefined,
): Promise<GatewayComputerStatus> {
  if (!context) {
    throw new Error("Gateway context is no longer available");
  }
  const status = await context.gatewayComputerService?.status({ probe: false });
  if (!status?.configured) {
    return { configured: false, available: false };
  }
  return status.available && status.computerUse
    ? { configured: true, available: true, computerUse: status.computerUse }
    : {
        configured: true,
        available: false,
        computerUse: status.computerUse,
        error: status.error,
      };
}

/** Loads host and node inventory only when an ordinary computer tool can reach the model. */
export async function loadPairedComputerUseAvailabilityForSurface(params: {
  computerAllowed: boolean;
  modelHasVision?: boolean;
  computerTransport?: ComputerToolTransport | null;
  embeddedMode?: boolean;
  signal?: AbortSignal;
}): Promise<PairedComputerUseAvailability | undefined> {
  if (
    !params.computerAllowed ||
    params.modelHasVision === false ||
    params.embeddedMode === true ||
    params.computerTransport !== undefined
  ) {
    return undefined;
  }
  const { signal } = params;
  const inProcess = shouldUseInProcessGatewayTool({});
  const context = inProcess
    ? getGatewayToolCallerIdentity()?.gatewayContextResolver?.()
    : undefined;
  // Hosted discovery consumes its owners' prepared facts; execution still admits live authority.
  const [nodes, gateway] = await Promise.all([
    (inProcess ? readLocalComputerNodes(context) : listNodes({}, signal)).catch(() => {
      signal?.throwIfAborted();
      return [];
    }),
    (inProcess ? readLocalComputerStatus(context) : loadGatewayComputerStatus({}, signal)).catch(
      (error: unknown): GatewayComputerStatus => {
        signal?.throwIfAborted();
        return {
          configured: true,
          available: false,
          error: error instanceof Error ? error.message : "Gateway computer discovery failed",
        };
      },
    ),
  ]);
  signal?.throwIfAborted();
  const eligible = nodes.filter(isEligibleComputerNode);
  const cacheKey = stableStringify({
    gateway,
    nodes: eligible
      // oxlint-disable-next-line unicorn/no-array-sort -- filter created this private array; node records stay untouched.
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map(({ nodeId, computerUse }) => ({ nodeId, computerUse })),
  });
  const capabilities = [
    ...eligible.map((node) => node.computerUse),
    ...(gateway.configured && gateway.computerUse ? [gateway.computerUse] : []),
  ];
  const advertised = new Set(
    capabilities.flatMap((capability) => capability?.actions ?? COMPUTER_USE_V1_ACTION_NAMES),
  );
  return {
    cacheKey,
    prepared: {
      actions: COMPUTER_USE_V2_ACTION_NAMES.filter((action) => advertised.has(action)),
      gateway,
      // Per-provider guidance is only exact when there is one possible target.
      guidanceCapabilities: capabilities.length === 1 ? capabilities[0] : undefined,
    },
  };
}

/** A paired target must support both observation and input to enter the computer tool pool. */
export function isEligibleComputerNode(node: NodeListNode): boolean {
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return (
    node.connected === true &&
    commands.includes(COMPUTER_ACT_COMMAND) &&
    commands.includes(SCREEN_SNAPSHOT_COMMAND)
  );
}
