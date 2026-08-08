import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "openclaw/plugin-sdk/file-lock";
import { QA_EVIDENCE_FILENAME } from "./evidence-summary.js";
import { resolveQaSuiteOutputDir } from "./suite-planning.js";

export type QaSuiteEvidenceTarget = { canonicalPath: string; stagedPath: string };
export async function runQaSuiteEvidenceLifecycle<Result>(
  params: { repoRoot?: string; outputDir?: string } | undefined,
  run: (resolved: {
    repoRoot: string;
    outputDir: string;
    target: QaSuiteEvidenceTarget;
  }) => Result | Promise<Result>,
): Promise<Result> {
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, params?.outputDir);
  const target = {
    canonicalPath: path.join(outputDir, QA_EVIDENCE_FILENAME),
    stagedPath: path.join(outputDir, `.${QA_EVIDENCE_FILENAME}.${randomUUID()}.staged`),
  } satisfies QaSuiteEvidenceTarget;
  const lock = await acquireFileLock(outputDir, {
    retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
    stale: 5 * 60_000,
    staleRecovery: "remove-if-unchanged",
  });
  let result: Result | undefined;
  const errors: unknown[] = [];
  try {
    await fs.rm(target.canonicalPath, { force: true });
    result = await run({ repoRoot, outputDir, target });
    await fs.rename(target.stagedPath, target.canonicalPath);
  } catch (error) {
    errors.push(error);
    await fs
      .rm(target.stagedPath, { force: true })
      .catch((discardError: unknown) => errors.push(discardError));
  }
  await lock.release().catch((error) => errors.push(error));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "QA suite evidence lifecycle failed", { cause: errors[0] });
  }
  return result as Result;
}
