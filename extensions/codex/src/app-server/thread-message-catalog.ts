import { normalizeCodexDynamicToolName } from "./dynamic-tool-profile.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolSpec,
} from "./protocol.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
} from "./thread-fingerprints.js";

/** Adopt only the old catalog missing message; every other spec must match exactly. */
export function resolveLegacyCodexMessageCatalog(
  previous: string | undefined,
  tools: CodexDynamicToolSpec[],
): CodexDynamicToolSpec[] | undefined {
  if (!previous) {
    return undefined;
  }
  const isMessage = (tool: { name: string }) =>
    normalizeCodexDynamicToolName(tool.name) === "message";
  let removed = false;
  const narrowed = tools.flatMap((tool): CodexDynamicToolSpec[] => {
    if (tool.type === "namespace") {
      if (tool.name !== "openclaw" && tool.name !== CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE) {
        return [tool];
      }
      const children = tool.tools.filter((child) => !isMessage(child));
      removed ||= children.length !== tool.tools.length;
      return children.length ? [{ ...tool, tools: children }] : [];
    }
    if (isMessage(tool)) {
      removed = true;
      return [];
    }
    return [tool];
  });
  return removed &&
    areCodexDynamicToolFingerprintsCompatible({
      previous,
      next: codexDynamicToolsFingerprint(narrowed),
      nextLegacy: codexLegacyDynamicToolsFingerprint(narrowed),
    })
    ? narrowed
    : undefined;
}
