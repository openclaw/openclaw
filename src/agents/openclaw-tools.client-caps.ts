import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * Client caps that gate core tools (`show_widget`, `screen`). Sessions record
 * them from interactive clients so internal turns declare the same catalog.
 */
export const TOOL_CATALOG_CLIENT_CAPS: readonly string[] = [
  GATEWAY_CLIENT_CAPS.INLINE_WIDGETS,
  GATEWAY_CLIENT_CAPS.UI_COMMANDS,
];

/**
 * Drops tools whose requiredClientCaps the originating gateway client did not
 * declare. Capability availability is a hard fact, not policy: every tool
 * assembly path (core, plugin-only plans) must apply it or gated tools leak
 * onto surfaces that cannot render them.
 */
export function filterToolsByClientCaps(
  tools: AnyAgentTool[],
  declaredClientCaps: string[] | undefined,
): AnyAgentTool[] {
  const clientCaps = new Set(declaredClientCaps ?? []);
  return tools.filter(
    (tool) => !tool.requiredClientCaps?.some((requiredCap) => !clientCaps.has(requiredCap)),
  );
}
