import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
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
  return loadPairedComputerUseAvailability(params.signal);
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

/** Projects Gateway and paired-node descriptors into the initial action surface. */
function preparePairedComputerUse(
  eligible: readonly NodeListNode[],
  gateway: GatewayComputerStatus,
): PreparedPairedComputerUse {
  const advertised = new Set<ComputerUseV2ActionName>();
  for (const node of eligible) {
    for (const action of node.computerUse?.actions ?? COMPUTER_USE_V1_ACTION_NAMES) {
      advertised.add(action);
    }
  }
  if (gateway.available) {
    for (const action of gateway.computerUse.actions) {
      advertised.add(action);
    }
  }
  return {
    actions: COMPUTER_USE_V2_ACTION_NAMES.filter((action) => advertised.has(action)),
    gateway,
    // Per-provider guidance is only exact when there is one possible target.
    guidanceCapabilities: gateway.available
      ? eligible.length === 0
        ? gateway.computerUse
        : undefined
      : eligible.length === 1
        ? eligible[0]?.computerUse
        : undefined,
  };
}

/** Loads current desktop facts before a model-facing tool catalog is serialized. */
async function loadPairedComputerUseAvailability(
  signal?: AbortSignal,
): Promise<PairedComputerUseAvailability> {
  const [nodes, gateway] = await Promise.all([
    listNodes({}, signal).catch(() => {
      signal?.throwIfAborted();
      return [];
    }),
    loadGatewayComputerStatus({}, signal).catch((error: unknown): GatewayComputerStatus => {
      signal?.throwIfAborted();
      return {
        configured: true,
        available: false,
        error: error instanceof Error ? error.message : "Gateway computer discovery failed",
      };
    }),
  ]);
  signal?.throwIfAborted();
  const eligible = nodes.filter(isEligibleComputerNode);
  return {
    cacheKey: stableStringify({
      gateway,
      nodes: eligible
        .toSorted((a, b) => a.nodeId.localeCompare(b.nodeId))
        .map(({ nodeId, computerUse }) => ({ nodeId, computerUse })),
    }),
    prepared: preparePairedComputerUse(eligible, gateway),
  };
}
