import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Blocked include migrations can leave Doctor candidates in the raw roster shape. */
export function readDoctorAgentEntries(config: unknown) {
  const agents = asOptionalObjectRecord(asOptionalObjectRecord(config)?.agents);
  const listed: unknown[] =
    Object.prototype.propertyIsEnumerable.call(agents ?? {}, "list") && Array.isArray(agents?.list)
      ? agents.list
      : [];
  return { keyed: asOptionalObjectRecord(agents?.entries), listed };
}
