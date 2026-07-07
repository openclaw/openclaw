export const DEFAULT_ARM_DURATION_MS = 15 * 60_000;
export const DEFAULT_SCREENSHOT_MAX_WIDTH = 1280;

export const COMPUTER_INPUT_ACTIONS = [
  "move",
  "click",
  "mouseDown",
  "mouseUp",
  "drag",
  "scroll",
  "key",
  "keyDown",
  "keyUp",
  "type",
  "hold",
] as const;

export type ComputerInputAction = (typeof COMPUTER_INPUT_ACTIONS)[number];

export type ComputerUseConfig = {
  defaultArmDurationMs: number;
  returnScreenshotAfterAction: boolean;
  screenshotMaxWidth: number;
  allowActions?: ReadonlySet<ComputerInputAction>;
};

function readPositiveSafeInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function readAllowedActions(value: unknown): ReadonlySet<ComputerInputAction> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const known = new Set<string>(COMPUTER_INPUT_ACTIONS);
  return new Set(
    value.filter(
      (entry): entry is ComputerInputAction => typeof entry === "string" && known.has(entry),
    ),
  );
}

export function resolveComputerUseConfig(value: unknown): ComputerUseConfig {
  const config =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const allowActions = readAllowedActions(config.allowActions);
  return {
    defaultArmDurationMs: readPositiveSafeInteger(
      config.defaultArmDurationMs,
      DEFAULT_ARM_DURATION_MS,
    ),
    returnScreenshotAfterAction:
      typeof config.returnScreenshotAfterAction === "boolean"
        ? config.returnScreenshotAfterAction
        : true,
    screenshotMaxWidth: readPositiveSafeInteger(
      config.screenshotMaxWidth,
      DEFAULT_SCREENSHOT_MAX_WIDTH,
    ),
    ...(allowActions ? { allowActions } : {}),
  };
}
