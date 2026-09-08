/**
 * Canonicalizes Codex namespaced tool names inside `automations` job payloads.
 *
 * Codex exposes OpenClaw dynamic tools under the `openclaw` and `openclaw_direct`
 * namespaces, so Code Mode shows them as `openclaw__read` or
 * `openclaw_direct__sandbox_exec`. The OpenClaw scheduler caps an automation to
 * the creating turn's tools by their canonical names; a namespaced entry never
 * matches, so the job needs creator authority the harness cannot always vouch
 * for and the add fails. Stripping the namespace only when the remainder is a
 * tool registered for this turn keeps the cap exact and never widens it.
 */
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE } from "./dynamic-tool-catalog.js";
import { CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE, type JsonValue } from "./protocol.js";

/** Canonical name of the OpenClaw scheduler tool (src/agents/tools/automations-tool-name.ts). */
export const CODEX_AUTOMATIONS_DYNAMIC_TOOL_NAME = "automations";

const CODEX_DYNAMIC_TOOL_NAMESPACE_SEPARATOR = "__";
const CODEX_DYNAMIC_TOOL_NAMESPACE_PREFIXES = [
  `${CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE}${CODEX_DYNAMIC_TOOL_NAMESPACE_SEPARATOR}`,
  `${CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE}${CODEX_DYNAMIC_TOOL_NAMESPACE_SEPARATOR}`,
] as const;

/**
 * Returns the canonical tool name for a Codex namespaced entry when the
 * remainder is a tool of this turn; every other value is returned unchanged.
 */
export function canonicalizeCodexNamespacedToolName(
  name: string,
  knownToolNames: ReadonlySet<string>,
): string {
  for (const prefix of CODEX_DYNAMIC_TOOL_NAMESPACE_PREFIXES) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const candidate = name.slice(prefix.length);
    if (candidate && knownToolNames.has(candidate)) {
      return candidate;
    }
  }
  return name;
}

/**
 * Rewrites `job.payload.toolsAllow` of an `automations` add/update call so
 * namespaced catalog names become the canonical names the scheduler compares
 * against. Unknown entries, wildcards and non-string values are untouched, and
 * the arguments object is returned as-is when nothing changes.
 */
export function canonicalizeCodexAutomationsToolsAllow(
  args: JsonValue | undefined,
  knownToolNames: ReadonlySet<string>,
): JsonValue | undefined {
  if (!isRecord(args)) {
    return args;
  }
  const job = args.job;
  if (!isRecord(job)) {
    return args;
  }
  const payload = job.payload;
  if (!isRecord(payload)) {
    return args;
  }
  const toolsAllow = payload.toolsAllow;
  if (!Array.isArray(toolsAllow)) {
    return args;
  }
  let changed = false;
  const canonicalToolsAllow = toolsAllow.map((entry) => {
    if (typeof entry !== "string") {
      return entry;
    }
    const canonical = canonicalizeCodexNamespacedToolName(entry, knownToolNames);
    if (canonical !== entry) {
      changed = true;
    }
    return canonical;
  });
  if (!changed) {
    return args;
  }
  return {
    ...args,
    job: {
      ...job,
      payload: {
        ...payload,
        toolsAllow: canonicalToolsAllow,
      },
    },
  } as JsonValue;
}
