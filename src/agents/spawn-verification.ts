import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  type VerificationArtifact,
  type VerificationCheckResult,
  type VerificationContract,
  type VerificationResult,
} from "./spawn-verification.types.js";

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 30_000;

const TIMEOUT_CHECK_TARGET = "<verification>";
const TIMEOUT_REASON = "verification_timeout";

type VerificationIo = {
  stat: (target: string) => Promise<Stats>;
  readFile: (target: string, encoding: BufferEncoding) => Promise<string>;
};

function isFiniteInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function normalizeTimeoutMs(value: unknown): number {
  if (!isFiniteInteger(value) || value <= 0) {
    return DEFAULT_VERIFICATION_TIMEOUT_MS;
  }
  return value;
}

function normalizeMinValue(value: unknown): number | undefined {
  if (!isFiniteInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function normalizeRequiredKeys(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

function buildFailure(reason: string, target: string): VerificationCheckResult {
  return {
    type: "artifact",
    target,
    passed: false,
    reason,
  };
}

function buildSuccess(target: string): VerificationCheckResult {
  return {
    type: "artifact",
    target,
    passed: true,
  };
}

function resolveArtifactPath(workspaceDir: string | undefined, artifactPath: string): string {
  return path.isAbsolute(artifactPath)
    ? artifactPath
    : path.resolve(workspaceDir ?? process.cwd(), artifactPath);
}

async function checkArtifact(
  artifact: VerificationArtifact,
  workspaceDir: string | undefined,
  io: VerificationIo,
): Promise<VerificationCheckResult> {
  const trimmedPath = artifact.path.trim();
  if (!trimmedPath) {
    return buildFailure("artifact_path_empty", "");
  }

  const target = resolveArtifactPath(workspaceDir, trimmedPath);
  const minBytes = normalizeMinValue(artifact.minBytes);
  const minItems = normalizeMinValue(artifact.minItems);
  const requiredKeys = normalizeRequiredKeys(artifact.requiredKeys);

  let stat: Stats;
  try {
    stat = await io.stat(target);
  } catch {
    return buildFailure("artifact_not_found", target);
  }

  if (!stat.isFile()) {
    return buildFailure("artifact_not_file", target);
  }

  if (minBytes !== undefined && stat.size < minBytes) {
    return buildFailure(`artifact_too_small (${stat.size} < ${minBytes} bytes)`, target);
  }

  if (!artifact.json) {
    return buildSuccess(target);
  }

  let raw: string;
  try {
    raw = await io.readFile(target, "utf-8");
  } catch {
    return buildFailure("artifact_unreadable", target);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return buildFailure("artifact_json_parse_failed", target);
  }

  if (!Array.isArray(parsed)) {
    return buildFailure("artifact_json_not_array", target);
  }

  if (minItems !== undefined && parsed.length < minItems) {
    return buildFailure(`artifact_json_too_few_items (${parsed.length} < ${minItems})`, target);
  }

  if (requiredKeys !== undefined) {
    const requiredSet = new Set(requiredKeys);

    for (const [index, entry] of parsed.entries()) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return buildFailure(`artifact_json_item_not_object_${index}`, target);
      }

      for (const key of requiredSet) {
        if (!(key in (entry as Record<string, unknown>))) {
          return buildFailure(`artifact_json_item_missing_required_key_${index}.${key}`, target);
        }
      }
    }
  }

  return buildSuccess(target);
}

async function runChecksWithTimeout(
  artifacts: VerificationArtifact[],
  workspaceDir: string | undefined,
  verificationTimeoutMs: number,
  io: VerificationIo,
): Promise<VerificationCheckResult[]> {
  const checks = async () => {
    const results: VerificationCheckResult[] = [];

    for (const artifact of artifacts) {
      results.push(await checkArtifact(artifact, workspaceDir, io));
    }

    return results;
  };

  return runWithTimeout(checks(), verificationTimeoutMs);
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(TIMEOUT_REASON));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  });
}

export async function runSpawnVerificationChecks(params: {
  contract?: VerificationContract;
  workspaceDir?: string;
  now?: () => number;
  timeoutMs?: number;
  hooks?: {
    stat?: (target: string) => Promise<Stats>;
    readFile?: (target: string, encoding: BufferEncoding) => Promise<string>;
  };
}): Promise<VerificationResult> {
  const artifacts = params.contract?.artifacts;
  const now = params.now ?? (() => Date.now());

  if (!artifacts || artifacts.length === 0) {
    return {
      status: "skipped",
      checks: [],
      verifiedAt: now(),
    };
  }

  const timeoutMs = normalizeTimeoutMs(
    params.timeoutMs ?? params.contract?.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
  );

  try {
    const io: VerificationIo = {
      stat: params.hooks?.stat ?? fs.stat,
      readFile: params.hooks?.readFile ?? fs.readFile,
    };

    const checks = await runChecksWithTimeout(artifacts, params.workspaceDir, timeoutMs, io);

    return {
      status: checks.every((check) => check.passed) ? "passed" : "failed",
      checks,
      verifiedAt: now(),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : undefined;

    if (reason === TIMEOUT_REASON) {
      return {
        status: "failed",
        checks: [buildFailure(TIMEOUT_REASON, TIMEOUT_CHECK_TARGET)],
        verifiedAt: now(),
      };
    }

    return {
      status: "failed",
      checks: [buildFailure(reason || "verification_failed", TIMEOUT_CHECK_TARGET)],
      verifiedAt: now(),
    };
  }
}
