import { asRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type ProducedLogbookConfig = ReturnType<typeof resolveLogbookConfig>;
type OptionalLogbookFields = "nodeId" | "visionModel";
export type LogbookConfig = Omit<ProducedLogbookConfig, OptionalLogbookFields> &
  Partial<Pick<ProducedLogbookConfig, OptionalLogbookFields>>;

const DEFAULTS = {
  captureEnabled: true,
  captureIntervalSeconds: 30,
  analysisIntervalMinutes: 15,
  screenIndex: 0,
  maxWidth: 1440,
  retentionDays: 14,
} as const;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export function resolveLogbookConfig(raw: unknown) {
  const value = asRecord(raw);
  return {
    captureEnabled: value.captureEnabled !== false,
    captureIntervalSeconds: clampNumber(
      value.captureIntervalSeconds,
      DEFAULTS.captureIntervalSeconds,
      5,
      600,
    ),
    analysisIntervalMinutes: clampNumber(
      value.analysisIntervalMinutes,
      DEFAULTS.analysisIntervalMinutes,
      3,
      120,
    ),
    nodeId: normalizeOptionalString(value.nodeId),
    screenIndex: clampNumber(value.screenIndex, DEFAULTS.screenIndex, 0, 16),
    maxWidth: clampNumber(value.maxWidth, DEFAULTS.maxWidth, 480, 3840),
    visionModel: normalizeOptionalString(value.visionModel),
    retentionDays: clampNumber(value.retentionDays, DEFAULTS.retentionDays, 1, 365),
  };
}

/** Splits a "provider/model" ref; model ids may themselves contain slashes. */
export function parseModelRef(ref: string): { provider: string; model: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return null;
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}
