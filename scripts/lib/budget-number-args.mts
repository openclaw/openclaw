import { stringFlag, type FlagSpec } from "./arg-utils.mts";

function parseBudgetNumber(raw: string | undefined, label: string): number | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

export function readBudgetEnvNumber(name: string, env = process.env) {
  return parseBudgetNumber(env[name], name);
}

export function budgetFloatFlag<T extends Record<string, unknown>>(
  flag: string,
  key: string,
): FlagSpec<T> {
  return stringFlag<T>(flag, key, {
    allowInline: false,
    rejectShortOptions: true,
    transform(value) {
      const parsed = parseBudgetNumber(value, flag);
      if (parsed === null) {
        throw new Error(`${flag} requires a value`);
      }
      return parsed;
    },
  });
}
