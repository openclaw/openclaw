import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import type {
  ComputerUseCapabilityDescriptor,
  ComputerUseV2ActionName,
} from "../plugins/computer-use-contract.js";
import {
  COMPUTER_USE_V1_ACTION_NAMES,
  COMPUTER_USE_V2_ACTION_NAMES,
} from "../plugins/computer-use-contract.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { supportsMobileUiNode } from "./mobile-ui-node-capabilities.js";
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
  /** Current-host support only; never part of descendant or scheduled authority. */
  unsupportedTools?: readonly ("computer" | "mobile_ui")[];
};

/** Apply only after policy/schema eligibility has been captured for future runtimes. */
export function omitUnsupportedNodeTools(
  tools: AnyAgentTool[],
  availability: PairedComputerUseAvailability | undefined,
): AnyAgentTool[] {
  const unsupported = availability?.unsupportedTools;
  return unsupported?.length
    ? tools.filter(
        (tool) => getPluginToolMeta(tool) || !unsupported.some((name) => name === tool.name),
      )
    : tools;
}

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

/** Reuse owner-prepared route facts only for node tools allowed on this surface. */
export async function loadPairedComputerUseAvailabilityForSurface(params: {
  computerAllowed: boolean;
  mobileUiAllowed?: boolean;
  config?: OpenClawConfig;
  modelHasVision?: boolean;
  computerTransport?: ComputerToolTransport | null;
  embeddedMode?: boolean;
  signal?: AbortSignal;
}): Promise<PairedComputerUseAvailability | undefined> {
  if (params.embeddedMode === true) {
    return undefined;
  }
  const ordinaryComputer =
    params.computerAllowed &&
    params.modelHasVision !== false &&
    params.computerTransport === undefined;
  if (!ordinaryComputer && !params.mobileUiAllowed) {
    return undefined;
  }
  const { signal } = params;
  const inProcess = shouldUseInProcessGatewayTool({});
  const caller = getGatewayToolCallerIdentity();
  const context = inProcess ? caller?.gatewayContextResolver?.() : undefined;
  // Only the hosted path can reuse prepared inventory for mobile-only listing.
  // Other callers remain unknown rather than adding a discovery round trip.
  if (!ordinaryComputer && !(inProcess && params.mobileUiAllowed)) {
    return undefined;
  }
  const attachments = context?.workerEnvironmentService;
  // A configured service can open a desktop later; an existing attachment can
  // be temporarily offline. Neither requires a paired node or a local display.
  const attachedComputerRoute = Boolean(
    ordinaryComputer &&
    attachments?.prepareAttachedComputer &&
    (params.config === undefined ||
      params.config.cloudWorkers?.desktop === true ||
      (caller?.agentId &&
        caller.sessionKey &&
        attachments.findSessionAttachment({
          agentId: caller.agentId,
          sessionKey: caller.sessionKey,
        }))),
  );
  // Hosted discovery consumes its owners' prepared facts; execution still admits live authority.
  const [nodes, gateway] = await Promise.all([
    (inProcess ? readLocalComputerNodes(context) : listNodes({}, signal)).catch(() => {
      signal?.throwIfAborted();
      return undefined;
    }),
    (ordinaryComputer
      ? inProcess
        ? readLocalComputerStatus(context)
        : loadGatewayComputerStatus({}, signal)
      : Promise.resolve(undefined)
    ).catch((error: unknown): GatewayComputerStatus => {
      signal?.throwIfAborted();
      return {
        configured: true,
        available: false,
        error: error instanceof Error ? error.message : "Gateway computer discovery failed",
      };
    }),
  ]);
  signal?.throwIfAborted();
  const eligible = nodes?.filter(isEligibleComputerNode) ?? [];
  const unsupportedTools: Array<"computer" | "mobile_ui"> = [];
  // Explicit matching remote URL overrides remain usable in local Gateway mode.
  // Local inventory cannot prove absence on that configured route; do not probe it.
  const configuredRemoteRoute = Boolean(params.config?.gateway?.remote?.url?.trim());
  if (nodes && !configuredRemoteRoute) {
    const known = nodes.filter((node) => node.paired === true || node.connected === true);
    if (
      ordinaryComputer &&
      gateway?.configured === false &&
      !attachedComputerRoute &&
      !known.some(supportsComputerNode)
    ) {
      unsupportedTools.push("computer");
    }
    if (params.mobileUiAllowed && !known.some(supportsMobileUiNode)) {
      unsupportedTools.push("mobile_ui");
    }
  }
  const cacheKey = stableStringify({
    gateway,
    attachedComputerRoute,
    configuredRemoteRoute,
    unsupportedTools,
    nodes: eligible
      // oxlint-disable-next-line unicorn/no-array-sort -- filter created this private array; node records stay untouched.
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map(({ nodeId, computerUse }) => ({ nodeId, computerUse })),
  });
  const capabilities = [
    ...eligible.map((node) => node.computerUse),
    ...(gateway?.configured && gateway.computerUse ? [gateway.computerUse] : []),
  ];
  const advertised = new Set(
    capabilities.flatMap((capability) => capability?.actions ?? COMPUTER_USE_V1_ACTION_NAMES),
  );
  return {
    cacheKey,
    unsupportedTools,
    prepared: ordinaryComputer
      ? {
          actions: COMPUTER_USE_V2_ACTION_NAMES.filter((action) => advertised.has(action)),
          gateway,
          // Per-provider guidance is only exact when there is one possible target.
          guidanceCapabilities: capabilities.length === 1 ? capabilities[0] : undefined,
        }
      : undefined,
  };
}

/** A paired target must support both observation and input to enter the computer tool pool. */
export function isEligibleComputerNode(node: NodeListNode): boolean {
  return node.connected === true && supportsComputerNode(node);
}

function supportsComputerNode(node: NodeListNode): boolean {
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return commands.includes(COMPUTER_ACT_COMMAND) && commands.includes(SCREEN_SNAPSHOT_COMMAND);
}
