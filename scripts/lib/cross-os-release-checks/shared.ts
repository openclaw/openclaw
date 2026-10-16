import { existsSync } from "node:fs";
import { join } from "node:path";
import { truncateUtf16Safe } from "../../../packages/normalization-core/src/utf16-slice.ts";

export function resolveCommandPath(command: string) {
  const pathValue = process.env.PATH ?? "";
  const pathEntries = pathValue.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const candidates =
    process.platform === "win32" && !command.toLowerCase().endsWith(".cmd")
      ? [`${command}.cmd`, `${command}.exe`, command]
      : [command];
  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = join(entry, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

export function shellEscapeForSh(value: string) {
  return value.replace(/'/gu, `'"'"'`);
}

export function trimForSummary(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 600) {
    return trimmed;
  }
  return `${truncateUtf16Safe(trimmed, 600)}...`;
}

function formatErrorHeadline(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.name}: ${error.message} (${error.errors.map(formatErrorHeadline).join("; ")})`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    // Summaries keep only 600 characters, so name every inner failure before any stack.
    return [
      formatErrorHeadline(error),
      ...error.errors.map((inner, index) => `[${index + 1}] ${formatError(inner)}`),
    ].join("\n");
  }
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

export function sleep(ms: number) {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
