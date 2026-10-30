import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { MANAGED_DREAMING_DECLARATION_KEY } from "../dreaming-cron-contract.js";

type DreamingCronIdentifiers = Pick<
  typeof import("openclaw/plugin-sdk/memory-core-host-status"),
  | "MANAGED_MEMORY_DREAMING_CRON_NAME"
  | "MANAGED_MEMORY_DREAMING_CRON_TAG"
  | "MEMORY_DREAMING_SYSTEM_EVENT_TEXT"
  | "LEGACY_MEMORY_LIGHT_DREAMING_CRON_NAME"
  | "LEGACY_MEMORY_LIGHT_DREAMING_CRON_TAG"
  | "LEGACY_MEMORY_LIGHT_DREAMING_EVENT_TEXT"
  | "LEGACY_MEMORY_REM_DREAMING_CRON_NAME"
  | "LEGACY_MEMORY_REM_DREAMING_CRON_TAG"
  | "LEGACY_MEMORY_REM_DREAMING_EVENT_TEXT"
>;

export type DreamingCronKind = "declared" | "legacy" | "phase" | "ambiguous";

/** Doctor owns historical recognition; runtime may use the result only for diagnosis. */
export function classifyDreamingCronJob(
  raw: Record<string, unknown>,
  constants: DreamingCronIdentifiers,
): DreamingCronKind | undefined {
  if (raw.declarationKey === MANAGED_DREAMING_DECLARATION_KEY) {
    return "declared";
  }
  if (raw.declarationKey !== undefined && raw.declarationKey !== null) {
    return undefined;
  }
  const name = normalizeOptionalString(raw.name);
  const description = normalizeOptionalString(raw.description);
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const kind = normalizeOptionalString(payload.kind)?.toLowerCase();
  const token = normalizeOptionalString(
    kind === "systemevent" ? payload.text : kind === "agentturn" ? payload.message : undefined,
  );
  let phase: "phase" | undefined;
  for (const [phaseName, tag, event] of [
    [
      constants.LEGACY_MEMORY_LIGHT_DREAMING_CRON_NAME,
      constants.LEGACY_MEMORY_LIGHT_DREAMING_CRON_TAG,
      constants.LEGACY_MEMORY_LIGHT_DREAMING_EVENT_TEXT,
    ],
    [
      constants.LEGACY_MEMORY_REM_DREAMING_CRON_NAME,
      constants.LEGACY_MEMORY_REM_DREAMING_CRON_TAG,
      constants.LEGACY_MEMORY_REM_DREAMING_EVENT_TEXT,
    ],
  ] as const) {
    if (description?.includes(tag)) {
      // A retained phase tag cannot authorize replacing an operator-authored prompt.
      if (token !== event && token !== constants.MEMORY_DREAMING_SYSTEM_EVENT_TEXT) {
        return "ambiguous";
      }
      phase = "phase";
    }
    if (name === phaseName && kind === "systemevent" && token === event) {
      phase = "phase";
    }
  }
  if (description?.includes(constants.MANAGED_MEMORY_DREAMING_CRON_TAG)) {
    if (token === constants.MEMORY_DREAMING_SYSTEM_EVENT_TEXT) {
      return "legacy";
    }
    return phase ?? "ambiguous";
  }
  if (
    name === constants.MANAGED_MEMORY_DREAMING_CRON_NAME &&
    token === constants.MEMORY_DREAMING_SYSTEM_EVENT_TEXT
  ) {
    return "legacy";
  }
  return phase;
}
