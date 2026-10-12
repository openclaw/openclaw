import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function collectFeishuDoctorAgentIds(cfg: unknown): string[] {
  const agents = isRecord(cfg) && isRecord(cfg.agents) ? cfg.agents : undefined;
  if (isRecord(agents?.entries)) {
    const ids = Object.keys(agents.entries).map(normalizeAgentId);
    return [...new Set(ids.length > 0 ? ids : ["main"])].toSorted();
  }
  // Blocked include migrations can leave a raw roster in Doctor's repair candidate.
  const entries =
    Object.prototype.propertyIsEnumerable.call(agents ?? {}, "list") && Array.isArray(agents?.list)
      ? agents.list.filter(isRecord)
      : [];
  const chosen = entries.find((entry) => entry.default === true) ?? entries[0];
  const ids = new Set([
    normalizeAgentId(typeof chosen?.id === "string" && chosen.id.trim() ? chosen.id : "main"),
  ]);
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.id.trim()) {
      ids.add(normalizeAgentId(entry.id));
    }
  }
  return [...ids].toSorted();
}
