import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

type LauncherPayload = {
  request: Record<string, unknown>;
  options: Record<string, unknown>;
};

/** Reads the launcher payload from an exec spec's argv, removing its temp file by default. */
export function decodePayload(
  argv: readonly string[],
  options: { cleanupPayloadFile?: boolean } = {},
): LauncherPayload {
  const payloadFileIndex = argv.indexOf("--payload-file");
  const payloadFile = argv[payloadFileIndex + 1];
  if (payloadFileIndex >= 0 && payloadFile !== undefined) {
    const decoded = JSON.parse(readFileSync(payloadFile, "utf-8")) as LauncherPayload;
    if (options.cleanupPayloadFile !== false) {
      rmSync(path.dirname(payloadFile), { force: true, recursive: true });
    }
    return decoded;
  }
  const payloadIndex = argv.indexOf("--payload");
  const payload = argv[payloadIndex + 1];
  if (payloadIndex < 0 || payload === undefined) {
    throw new Error(`expected --payload in argv: ${JSON.stringify(argv)}`);
  }
  return JSON.parse(Buffer.from(payload, "base64").toString("utf-8")) as LauncherPayload;
}

export function decodeRequest(argv: readonly string[]): Record<string, unknown> {
  return decodePayload(argv).request;
}

export function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  expect(field).toEqual(expect.any(Object));
  return field as Record<string, unknown>;
}

export function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  expect(field).toEqual(expect.any(Array));
  return field as string[];
}

export function environmentEntries(request: Record<string, unknown>): string[] {
  return Object.entries(objectField(request, "environment")).map(
    ([key, value]) => `${key}=${String(value)}`,
  );
}
