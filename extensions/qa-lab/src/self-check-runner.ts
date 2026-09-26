import path from "node:path";
import { startQaLabServer } from "./lab-server.js";
import { isQaSelfCheckSuccessful, type QaSelfCheckResult } from "./self-check.js";

type QaLabSelfCheckParams = {
  repoRoot?: string;
  outputPath?: string;
};

export type QaLabSelfCheckCommandOptions = {
  repoRoot?: string;
  output?: string;
};

async function withSelfCheck<T>(
  params: QaLabSelfCheckParams | undefined,
  consume: (result: QaSelfCheckResult) => T | Promise<T>,
): Promise<T> {
  const server = await startQaLabServer({
    repoRoot: params?.repoRoot,
    outputPath: params?.outputPath,
  });
  // Consume the report before shutdown, then preserve both failures without
  // letting cleanup replace the primary cause.
  const [run] = await Promise.allSettled([
    Promise.resolve().then(async () => await consume(await server.runSelfCheck())),
  ]);
  const [cleanup] = await Promise.allSettled([Promise.resolve().then(() => server.stop())]);
  if (run.status === "rejected") {
    if (cleanup.status === "rejected") {
      throw new AggregateError([run.reason, cleanup.reason], "QA self-check and shutdown failed", {
        cause: run.reason,
      });
    }
    throw run.reason;
  }
  if (cleanup.status === "rejected") {
    throw cleanup.reason;
  }
  return run.value;
}

export async function runQaLabSelfCheck(params?: QaLabSelfCheckParams) {
  return await withSelfCheck(params, (result) => result);
}

export async function runQaLabSelfCheckCommand(opts: QaLabSelfCheckCommandOptions) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  await withSelfCheck(
    {
      repoRoot,
      outputPath: opts.output ? path.resolve(repoRoot, opts.output) : undefined,
    },
    (result) => {
      process.stdout.write(`QA self-check report: ${result.outputPath}\n`);
      if (!isQaSelfCheckSuccessful(result)) {
        throw new Error(`QA self-check failed. See ${result.outputPath}.`);
      }
    },
  );
}

export const runQaE2eSelfCheck = runQaLabSelfCheck;
