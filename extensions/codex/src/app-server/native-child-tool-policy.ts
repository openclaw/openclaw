import {
  getPluginToolMeta,
  isMessagingTool,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createToolNamePatternMatcher,
  isKnownCoreToolId,
} from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import type { CodexPluginConfig } from "./config-contracts.js";

// These core tools act on the delegated host workspace or return results to the
// caller. Others need explicit child semantics (e.g. reply delivery, session
// control, nested tool dispatch). Never opt a new core control in via "*".
const CHILD_COMPATIBLE_CORE_TOOLS = new Set([
  "ls",
  "read",
  "write",
  "edit",
  "apply_patch",
  "skills_read",
  "skills_search",
  "memory_search",
  "memory_get",
  "web_search",
  "web_fetch",
  "x_search",
  "pdf",
  "view_image",
]);

type CatalogRow = {
  name: string;
  owner?: string;
  status: "allowed" | "denied" | "unavailable" | "unsupported";
  reason: string;
};

/** Inspect a host-projected surface without invoking tools or resolving new credentials. */
export function resolveNativeChildToolCatalog(params: {
  policy: CodexPluginConfig["nativeChildTools"];
  availableTools: readonly AnyAgentTool[];
  registeredNames?: Iterable<string>;
}) {
  const compile = (patterns: readonly string[] = []) =>
    [...new Set(patterns)].map((pattern) => ({
      pattern,
      matches: createToolNamePatternMatcher(pattern),
      matched: false,
    }));
  const allow = compile(params.policy?.allow);
  const deny = compile(params.policy?.deny);
  const available = new Map(params.availableTools.map((tool) => [tool.name, tool]));
  const registered = new Set(params.registeredNames ?? available.keys());
  const matches = (patterns: typeof allow, name: string) => {
    // Do not short-circuit: overlapping patterns must both count as matched.
    let any = false;
    for (const entry of patterns) {
      if (entry.matches(name)) {
        any = true;
        entry.matched = true;
      }
    }
    return any;
  };
  const tools = [...new Set([...registered, ...available.keys()])]
    .toSorted()
    .map((name): CatalogRow => {
      const allowed = matches(allow, name);
      const denied = matches(deny, name);
      const tool = available.get(name);
      const meta = tool && getPluginToolMeta(tool);
      const core = isKnownCoreToolId(name);
      const owner = meta?.mcp?.serverName ?? meta?.pluginId ?? (core && tool ? "core" : undefined);
      if (!tool || !registered.has(name)) {
        return {
          name,
          owner,
          status: "unavailable",
          reason: "Not on the executable host surface for this child.",
        };
      }
      if (!CHILD_COMPATIBLE_CORE_TOOLS.has(name) && (!meta || core || isMessagingTool(name))) {
        return {
          name,
          owner,
          status: "unsupported",
          reason: "No native-child execution semantics for this tool.",
        };
      }
      if (denied || !allowed) {
        return {
          name,
          owner,
          status: "denied",
          reason: denied
            ? "Excluded by nativeChildTools.deny."
            : "Not granted by nativeChildTools.allow.",
        };
      }
      return {
        name,
        owner,
        status: "allowed",
        reason: "Granted under the owning session's host authority.",
      };
    });
  return {
    tools,
    unmatchedAllow: allow.filter((entry) => !entry.matched).map((entry) => entry.pattern),
    unmatchedDeny: deny.filter((entry) => !entry.matched).map((entry) => entry.pattern),
  };
}
