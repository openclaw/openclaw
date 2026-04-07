import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "..");
const tscBin = require.resolve("typescript/bin/tsc");

export function createPrefixedOutputWriter(label, target) {
  let buffered = "";
  const prefix = `[${label}] `;

  return {
    write(chunk) {
      buffered += chunk;
      while (true) {
        const newlineIndex = buffered.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }
        const line = buffered.slice(0, newlineIndex + 1);
        buffered = buffered.slice(newlineIndex + 1);
        target.write(`${prefix}${line}`);
      }
    },
    flush() {
      if (!buffered) {
        return;
      }
      target.write(`${prefix}${buffered}`);
      buffered = "";
    },
  };
}

function abortSiblingSteps(abortController) {
  if (abortController && !abortController.signal.aborted) {
    abortController.abort();
  }
}

export function runNodeStep(label, args, timeoutMs, params = {}) {
  const abortController = params.abortController;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      signal: abortController?.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const stdoutWriter = createPrefixedOutputWriter(label, process.stdout);
    const stderrWriter = createPrefixedOutputWriter(label, process.stderr);
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGTERM");
      settled = true;
      stdoutWriter.flush();
      stderrWriter.flush();
      abortSiblingSteps(abortController);
      rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutWriter.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrWriter.write(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      stdoutWriter.flush();
      stderrWriter.flush();
      if (error.name === "AbortError" && abortController?.signal.aborted) {
        rejectPromise(new Error(`${label} canceled after sibling failure`));
        return;
      }
      abortSiblingSteps(abortController);
      rejectPromise(new Error(`${label} failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      stdoutWriter.flush();
      stderrWriter.flush();
      if (code === 0) {
        resolvePromise();
        return;
      }
      abortSiblingSteps(abortController);
      rejectPromise(new Error(`${label} failed with exit code ${code ?? 1}`));
    });
  });
}

export async function runNodeStepsInParallel(steps) {
  const abortController = new AbortController();
  const results = await Promise.allSettled(
    steps.map((step) => runNodeStep(step.label, step.args, step.timeoutMs, { abortController })),
  );
  const firstFailure = results.find((result) => result.status === "rejected");
  if (firstFailure) {
    throw firstFailure.reason;
  }
}

export async function main() {
  try {
    await runNodeStepsInParallel([
      {
        label: "plugin-sdk boundary dts",
        args: [tscBin, "-p", "tsconfig.plugin-sdk.dts.json"],
        timeoutMs: 300_000,
      },
      {
        label: "plugin-sdk package boundary dts",
        args: [tscBin, "-p", "packages/plugin-sdk/tsconfig.json"],
        timeoutMs: 300_000,
      },
    ]);
    await runNodeStep(
      "plugin-sdk boundary root shims",
      ["--import", "tsx", resolve(repoRoot, "scripts/write-plugin-sdk-entry-dts.ts")],
      120_000,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
