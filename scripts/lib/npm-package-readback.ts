// Exact npm package readback shared by regular and extended-stable release verification.
import { execFileSync } from "node:child_process";

const NPM_VIEW_ATTEMPTS = 30;
const NPM_VIEW_RETRY_MAX_DELAY_MS = 10_000;

export type NpmViewFields = {
  version?: string;
  distTagVersion?: string;
  integrity?: string;
  tarball?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function runNpm(args: string[]): string {
  return execFileSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export async function runNpmViewWithRetry(
  args: string[],
  options: {
    attempts?: number;
    delay?: (delayMs: number) => Promise<void>;
    run?: (args: string[]) => string;
  } = {},
): Promise<string> {
  const attempts = options.attempts ?? NPM_VIEW_ATTEMPTS;
  const delay =
    options.delay ??
    ((delayMs: number) =>
      new Promise((resolveDelay) => {
        setTimeout(resolveDelay, delayMs);
      }));
  const run = options.run ?? runNpm;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return run([...args, "--prefer-online"]);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await delay(Math.min(attempt * 1000, NPM_VIEW_RETRY_MAX_DELAY_MS));
    }
  }
  throw lastError;
}

export function parseNpmViewFields(raw: string, distTag: string): NpmViewFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`npm view returned invalid JSON: ${message}`, { cause: error });
  }
  if (Array.isArray(parsed)) {
    return {
      version: readString(parsed[0]),
      distTagVersion: readString(parsed[1]),
      integrity: readString(parsed[2]),
      tarball: readString(parsed[3]),
    };
  }
  if (!isRecord(parsed)) {
    throw new Error("npm view returned an unsupported JSON shape.");
  }
  const distTags = isRecord(parsed["dist-tags"]) ? parsed["dist-tags"] : undefined;
  const dist = isRecord(parsed.dist) ? parsed.dist : undefined;
  return {
    version: readString(parsed.version),
    distTagVersion: readString(parsed[`dist-tags.${distTag}`]) ?? readString(distTags?.[distTag]),
    integrity: readString(parsed["dist.integrity"]) ?? readString(dist?.integrity),
    tarball: readString(parsed["dist.tarball"]) ?? readString(dist?.tarball),
  };
}

export async function verifyNpmPackage(
  packageName: string,
  version: string,
  distTag?: string,
): Promise<NpmViewFields> {
  const readbackDistTag = distTag ?? "latest";
  const raw = await runNpmViewWithRetry([
    "view",
    `${packageName}@${version}`,
    "version",
    `dist-tags.${readbackDistTag}`,
    "dist.integrity",
    "dist.tarball",
    "--json",
  ]);
  const fields = parseNpmViewFields(raw, readbackDistTag);
  if (fields.version !== version) {
    throw new Error(
      `${packageName}: expected npm version ${version}, got ${fields.version ?? "<missing>"}.`,
    );
  }
  if (distTag && fields.distTagVersion !== version) {
    throw new Error(
      `${packageName}: npm dist-tag ${distTag} points to ${fields.distTagVersion ?? "<missing>"}, expected ${version}.`,
    );
  }
  if (fields.integrity === undefined) {
    throw new Error(`${packageName}: npm dist.integrity missing for ${version}.`);
  }
  if (fields.tarball === undefined) {
    throw new Error(`${packageName}: npm dist.tarball missing for ${version}.`);
  }
  return fields;
}
