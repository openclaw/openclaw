import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const desktopResizeStages = [
  "02-panel",
  "03-panel-resized",
  "04-fullscreen",
  "05-portrait",
  "06-landscape",
] as const;
const sha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
export const desktopProofTestPhases = [
  "fixture",
  "gateway-config",
  "gateway-start",
  "admin-connect",
  "node-admission",
  "guest-ssh",
  "browser-context",
  "browser-navigation",
  "ui-ready",
  "desktop-connect",
  "initial-framebuffer",
  "control-takeover",
  "resize-matrix",
] as const;
const desktopTestFile = "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts";
const failureSourceFiles = [
  desktopTestFile,
  "ui/src/e2e/desktop-resize-real.test-support.ts",
  "ui/src/e2e/control-ui-e2e-suite.test-support.ts",
  "ui/src/test-helpers/control-ui-e2e.ts",
  "ui/src/test-helpers/control-ui-e2e-readiness.ts",
  "test/e2e/qa-lab/runtime/skill-library-node-process.ts",
  "test/e2e/qa-lab/runtime/skill-library-wire-fixture.ts",
  "test/e2e/qa-lab/runtime/cloud-worker-midturn-loss-fixture.ts",
  "test/helpers/openclaw-test-instance.ts",
];

function reportInteger(value: unknown, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error("Invalid desktop test report number");
  }
  return Number(value);
}

function publicTestFailure(value: unknown) {
  if (typeof value !== "string" || value.length > 64 * 1024) {
    throw new Error("Invalid desktop test failure");
  }
  const message = stripVTControlCharacters(value).trimStart();
  // Vitest emits these exact timeout prefixes; elapsed time is not failure evidence.
  const category = /^(?:Error: )?Test timed out in \d+ms(?:\.| while waiting for )/u.test(message)
    ? "test-timeout"
    : /^(?:Error: )?Hook timed out in \d+ms(?:\.| while waiting for )/u.test(message)
      ? "hook-timeout"
      : (/^(AssertionError|TimeoutError|TypeError|ReferenceError|SyntaxError|RangeError):/u.exec(
          message,
        )?.[1] ?? "test-error");
  const locations = failureSourceFiles
    .flatMap((file) =>
      [
        ...message
          .replaceAll("\\", "/")
          .matchAll(new RegExp(`${file.replaceAll(".", "\\.")}:(\\d+):(\\d+)`, "gu")),
      ]
        .slice(0, 4)
        .map((match) => ({
          file,
          line: reportInteger(Number(match[1]), 100_000),
          column: reportInteger(Number(match[2]), 100_000),
        })),
    )
    .slice(0, 8);
  return { category, failureLocations: locations };
}

/** Project the private built-in Vitest report; no error text, arbitrary metadata, or paths escape. */
export function desktopProofTestReport(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.testResults) || value.testResults.length > 4) {
    throw new Error("Invalid desktop test report");
  }
  const statuses = new Set(["passed", "failed", "pending", "skipped", "todo"]);
  return {
    totalTests: reportInteger(value.numTotalTests, 16),
    failedTests: reportInteger(value.numFailedTests, 16),
    failedSuites: reportInteger(value.numFailedTestSuites, 16),
    files: value.testResults.map((file) => {
      if (
        !isRecord(file) ||
        typeof file.name !== "string" ||
        !file.name.replaceAll("\\", "/").endsWith(`/${desktopTestFile}`) ||
        !Array.isArray(file.assertionResults) ||
        file.assertionResults.length > 16 ||
        (file.status !== "passed" && file.status !== "failed")
      ) {
        throw new Error("Unexpected desktop test report file");
      }
      return {
        file: desktopTestFile,
        status: file.status,
        suiteFailure: file.message ? publicTestFailure(file.message) : null,
        assertions: file.assertionResults.map((test, index) => {
          if (
            !isRecord(test) ||
            typeof test.status !== "string" ||
            !statuses.has(test.status) ||
            !Array.isArray(test.failureMessages) ||
            test.failureMessages.length > 8
          ) {
            throw new Error("Invalid desktop assertion report");
          }
          const meta = isRecord(test.meta) ? test.meta : {};
          const phase =
            desktopProofTestPhases.find((candidate) => candidate === meta.desktopProofPhase) ??
            "unknown";
          return {
            index,
            status: test.status,
            phase,
            declarationLocation: isRecord(test.location)
              ? {
                  line: reportInteger(test.location.line, 100_000),
                  column: reportInteger(test.location.column, 100_000),
                }
              : null,
            failures: test.failureMessages.map(publicTestFailure),
          };
        }),
      };
    }),
  };
}

export async function readDesktopProofTestReport(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error("Desktop test report must be a bounded regular file");
  }
  return desktopProofTestReport(JSON.parse(await readFile(file, "utf8")));
}

/** Preserve child ownership before fallible logging or evidence export can replace its error. */
export async function withDesktopProofCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
  recordFailure: (error: unknown) => void,
): Promise<T> {
  const errors: unknown[] = [];
  let result: T | undefined;
  try {
    result = await operation();
  } catch (error) {
    recordFailure(error);
    errors.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    recordFailure(error);
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Desktop proof operation or cleanup failed");
  }
  return result as T;
}

export function desktopProofCommit(head: string, rawCommit: string) {
  // Read stored headers, not traversal-derived parents hidden at shallow boundaries.
  const headers = (rawCommit.split("\n\n", 1)[0] ?? "").split("\n");
  return {
    head,
    tree: headers[0]?.startsWith("tree ") ? headers[0].slice(5) : "",
    parents: headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7)),
  };
}

export function desktopProofSource(
  actual: { head: string; tree: string; parents: string[] },
  expected: { checkout: string; head?: string; base?: string },
) {
  if (
    !sha.test(actual.head) ||
    !sha.test(actual.tree) ||
    actual.parents.some((parent) => !sha.test(parent)) ||
    actual.head !== expected.checkout
  ) {
    throw new Error("Desktop proof checkout identity mismatch");
  }
  let kind = "checkout";
  if (expected.head || expected.base) {
    if (!sha.test(expected.head ?? "") || !sha.test(expected.base ?? "")) {
      throw new Error("Desktop proof requires both PR event SHAs");
    }
    kind = actual.head === expected.head ? "pr-head" : "pr-merge";
    if (
      kind === "pr-merge" &&
      (actual.parents.length !== 2 || actual.parents[1] !== expected.head)
    ) {
      throw new Error("Desktop proof merge parents do not match the PR event");
    }
  }
  // Event base and the immutable test merge's first parent can differ on GitHub.
  return {
    ...actual,
    kind,
    prHead: expected.head || null,
    prEventBase: expected.base || null,
    testedBase: kind === "pr-merge" ? (actual.parents[0] ?? null) : null,
  };
}

function geometry(value: unknown) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    Number(value.width) < 1 ||
    Number(value.height) < 1 ||
    Number(value.width) > 8192 ||
    Number(value.height) > 8192
  ) {
    throw new Error("Invalid desktop proof geometry");
  }
  return { width: Number(value.width), height: Number(value.height) };
}

export function desktopProofAssets(value: unknown) {
  if (!isRecord(value) || Object.keys(value).length < 1 || Object.keys(value).length > 64) {
    throw new Error("Missing or unbounded served assets");
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, hash]) => {
      if (
        !/^(?:index|desktop)[\w.-]*\.js$/u.test(name) ||
        typeof hash !== "string" ||
        !digest.test(hash)
      ) {
        throw new Error("Invalid served asset identity");
      }
      return [name, hash];
    }),
  ) as Record<string, string>;
}

export function sanitizeDesktopResizeProof(value: unknown, carrier: "node" | "ssh") {
  if (
    !isRecord(value) ||
    value.carrier !== carrier ||
    value.observerFilterPhase !== (carrier === "node" ? "clientInit" : "version") ||
    !isRecord(value.observer) ||
    value.observer.keyboardForwardedBytes !== 0 ||
    value.observer.resizeForwardedBytes !== 0 ||
    !isRecord(value.pixels) ||
    !Number.isSafeInteger(value.pixels.distinctSampledColors) ||
    Number(value.pixels.distinctSampledColors) <= 8 ||
    !Array.isArray(value.samples) ||
    value.samples.length !== desktopResizeStages.length ||
    (carrier === "node" &&
      (!isRecord(value.node) ||
        value.node.passwordAbsentFromObserve !== true ||
        value.node.disconnectClosedViewer !== true)) ||
    (carrier === "ssh" && value.node !== null)
  ) {
    throw new Error("Missing completed desktop carrier proof");
  }
  const samples = value.samples.map((sample, index) => {
    if (!isRecord(sample) || sample.stage !== desktopResizeStages[index]) {
      throw new Error("Missing desktop resize stage");
    }
    return { stage: desktopResizeStages[index], ...geometry(sample) };
  });
  // Never copy arbitrary fixture metadata, node IDs, diagnostics, or credentials.
  return {
    carrier,
    observerFilterPhase: value.observerFilterPhase,
    node:
      carrier === "node" ? { passwordAbsentFromObserve: true, disconnectClosedViewer: true } : null,
    observer: { keyboardForwardedBytes: 0, resizeForwardedBytes: 0 },
    viewports: "native desktop windows; viewport-emulated mobile, not a physical phone",
    assets: desktopProofAssets(value.assets),
    samples,
    pixels: { distinctSampledColors: Number(value.pixels.distinctSampledColors) },
  };
}

/** Export a bounded allowlist, including useful partial captures after a failed test. */
export async function exportDesktopResizeProof(
  input: string,
  output: string,
  carrier: "node" | "ssh",
  budget = { entries: 0, bytes: 0 },
) {
  const allowed = new Set([
    "01-fit.png",
    "served-assets.json",
    "resize-proof.json",
    ...desktopResizeStages.flatMap((stage) => [`${stage}.png`, `${stage}-geometry.json`]),
  ]);
  const exported = new Set<string>();
  let proof: ReturnType<typeof sanitizeDesktopResizeProof> | undefined;
  await mkdir(output, { recursive: true });
  const visit = async (directory: string, depth: number) => {
    if (depth > 4) {
      throw new Error("Desktop proof directory depth exceeded");
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++budget.entries > 256 || entry.isSymbolicLink()) {
        throw new Error("Desktop proof entry bound or regular-file contract violated");
      }
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file, depth + 1);
        continue;
      }
      if (!allowed.has(entry.name)) {
        continue;
      }
      const stat = await lstat(file);
      budget.bytes += stat.size;
      if (
        !stat.isFile() ||
        stat.size > 8 * 1024 * 1024 ||
        budget.bytes > 64 * 1024 * 1024 ||
        exported.has(entry.name)
      ) {
        throw new Error("Desktop proof file bound or uniqueness contract violated");
      }
      const data = await readFile(file);
      let safe: unknown;
      if (entry.name.endsWith(".png")) {
        if (
          data.length < 33 ||
          !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          data.toString("ascii", 12, 16) !== "IHDR" ||
          data.readUInt32BE(16) < 1 ||
          data.readUInt32BE(16) > 8192 ||
          data.readUInt32BE(20) < 1 ||
          data.readUInt32BE(20) > 8192
        ) {
          throw new Error("Invalid desktop screenshot");
        }
      } else {
        const value: unknown = JSON.parse(data.toString("utf8"));
        if (entry.name === "resize-proof.json") {
          proof = sanitizeDesktopResizeProof(value, carrier);
          safe = proof;
        } else if (entry.name === "served-assets.json") {
          safe = desktopProofAssets(value);
        } else {
          const stage = entry.name.replace(/-geometry\.json$/u, "");
          if (
            !isRecord(value) ||
            value.stage !== stage ||
            typeof value.matchOffered !== "boolean"
          ) {
            throw new Error("Invalid desktop geometry evidence");
          }
          safe = {
            stage,
            expected: geometry(value.expected),
            guest: geometry(value.guest),
            canvas: geometry(value.canvas),
            matchOffered: value.matchOffered,
          };
        }
      }
      await writeFile(
        path.join(output, entry.name),
        safe === undefined ? data : `${JSON.stringify(safe, null, 2)}\n`,
      );
      exported.add(entry.name);
    }
  };
  await visit(input, 0);
  return { proof, complete: Boolean(proof) && exported.size === allowed.size };
}
