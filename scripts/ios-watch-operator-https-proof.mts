import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat as fsStat,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHTTPSServer } from "node:https";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TLSSocket } from "node:tls";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { redactForDevToolLog } from "./lib/dev-tooling-safety.js";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";
import { observeOwnedWatchSimulator } from "./lib/watch-simulator-observation.mts";

const scopes = ["operator.read", "operator.talk"];
const developerDirectory = "/Applications/Xcode.app/Contents/Developer";
const cancelled = new AbortController();
type Phase = "identity" | "negative" | "positive" | "voice";
type CommandOptions = { timeout?: number; cleanup?: boolean; diagnostic?: boolean };
type PhaseOutput = { stdout: string; stderr?: string; truncated?: boolean };
type RunCommand = (
  label: string,
  tool: string,
  args: string[],
  options?: CommandOptions,
) => Promise<{ code: number } & PhaseOutput>;
type BuildStep = { event: string; label: string; code?: number };

function publicBuildOutput(text: string): string {
  // Redact whole streams before selecting a tail: secrets and paths can span pipe chunks.
  const located = stripVTControlCharacters(text).replace(
    /^[\t ]*\/[^\r\n]+?:(\d+):(\d+): (?=(?:error|warning|fatal error)\b)/gm,
    "[path]:$1:$2: ",
  );
  const redacted = redactForDevToolLog(located)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z0-9-]+\b/gi, "[identifier]")
    .replace(/\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]{0,39}\b/gi, "[address]");
  return (
    redacted
      .split(/\r?\n/)
      // Other path-bearing lines have no unambiguous boundary when paths contain spaces.
      .filter(
        (line) =>
          !line.includes("/") &&
          /^(?:.*:\d+:\d+: )?(?:error|warning|fatal error)\b|^\s*(?:Compiling|Checking|Downloading|Downloaded|Finished|SwiftCompile|CompileSwift|CompileC|CodeSign|Resolve Package Graph|Fetching|Creating working copy|Checking out|\*\* (?:TEST )?BUILD )/.test(
            line,
          ),
      )
      .map((line) => (/…|\*\*\*|PRIVATE KEY/.test(line) ? "[redacted sensitive output]" : line))
      .join("\n")
      .replace(/[^\x20-\x7e\n\t]/g, "?")
      .slice(-4096)
  );
}

function identityOutput(stdout: string, stderr: string, truncated: boolean) {
  type Observation = "unavailable" | "ambiguous" | "expected-suite";
  const diagnostic = {
    reportedCount: null as number | null,
    summaryOutcome: (truncated ? "ambiguous" : "unavailable") as
      | "unavailable"
      | "ambiguous"
      | "passed"
      | "failed",
    attribution: (truncated ? "ambiguous" : "unavailable") as Observation,
    expectedQualificationStart: null as boolean | null,
    expectedQualificationPass: null as boolean | null,
    expectedQualificationFail: null as boolean | null,
    expectedQualificationSkip: null as boolean | null,
    truncated,
  };
  if (truncated) {
    return diagnostic;
  }
  // Console text is unstable and skipped tests count in its summary. These scalars
  // never admit a phase; stream-local suite context cannot cross stdout/stderr.
  const seconds = String.raw`(?:0|[1-9]\d*)(?:\.\d+)? seconds`;
  const completion = String.raw`(?:passed after ${seconds}|failed after ${seconds} with (?:1 issue|(?:[2-9]|[1-9]\d+) issues))\.`;
  const ending = String.raw`(?:started\.|${completion}|skipped(?:\.|: "[^"\r\n]*"))`;
  const suitePattern = new RegExp(`^Suite (.+) (${ending})$`);
  const testPattern = new RegExp(String.raw`^Test qualification\(\) (${ending})$`);
  const summaryPattern = new RegExp(
    String.raw`^Test run with (0|[1-9]\d*) (tests?) in (0|[1-9]\d*) (suites?) (${completion})$`,
  );
  const streams = [stdout, stderr].map((text) => {
    const events = { started: 0, passed: 0, failed: 0, skipped: 0 };
    let suiteSeen = false,
      active = false,
      starts = 0,
      conflict = false,
      unattributed = false,
      unknownFormat = false;
    const summaries: { count: number; outcome: "passed" | "failed" }[] = [];
    let summaryLines = 0;
    for (const raw of stripVTControlCharacters(text).split(/\r?\n/).slice(0, -1)) {
      const line = raw.replace(/^[\s\u200b]*[\u25c7\u2714\u2718\u21b7]?[\t ]*/, "");
      const suite = suitePattern.exec(line);
      unknownFormat ||= line.startsWith("Suite ") && !suite;
      if (suite) {
        suiteSeen = true;
        const expected = suite[1] === "WatchOperatorHTTPSQualificationTests";
        conflict ||= !expected;
        active = expected && suite[2] === "started.";
        if (active) {
          starts++;
        }
      }
      const event = testPattern.exec(line);
      unknownFormat ||= line.startsWith("Test qualification() ") && !event;
      if (event) {
        unattributed ||= !active;
        if (event[1] === "started.") {
          events.started++;
        } else if (event[1]?.startsWith("passed after ")) {
          events.passed++;
        } else if (event[1]?.startsWith("failed after ")) {
          events.failed++;
        } else {
          events.skipped++;
        }
      }
      if (line.startsWith("Test run with ")) {
        summaryLines++;
        const summary = summaryPattern.exec(line);
        if (
          summary &&
          summaries.length < 2 &&
          Number.isSafeInteger(Number(summary[1])) &&
          Number.isSafeInteger(Number(summary[3])) &&
          summary[2] === (Number(summary[1]) === 1 ? "test" : "tests") &&
          summary[4] === (Number(summary[3]) === 1 ? "suite" : "suites")
        ) {
          summaries.push({
            count: Number(summary[1]),
            outcome: summary[5]?.startsWith("passed ") ? "passed" : "failed",
          });
        }
      }
    }
    return {
      events,
      suiteSeen,
      starts,
      conflict,
      unattributed,
      unknownFormat,
      summaries,
      summaryLines,
    };
  });
  const summaryLines = streams.reduce((total, stream) => total + stream.summaryLines, 0);
  const summaries = streams.flatMap((stream) => stream.summaries);
  if (summaryLines > 1) {
    diagnostic.summaryOutcome = "ambiguous";
  } else if (summaryLines === 1 && summaries[0]) {
    diagnostic.reportedCount = summaries[0].count;
    diagnostic.summaryOutcome = summaries[0].outcome;
  }
  const relevant = streams.filter(
    (stream) =>
      stream.suiteSeen || stream.unknownFormat || Object.values(stream.events).some(Boolean),
  );
  const stream = relevant[0];
  if (
    !stream ||
    relevant.some((value) => value.unknownFormat) ||
    !relevant.some((value) => value.suiteSeen)
  ) {
    return diagnostic;
  }
  const { started, passed, failed, skipped } = stream.events;
  if (
    relevant.length !== 1 ||
    stream.conflict ||
    stream.unattributed ||
    stream.starts > 1 ||
    Object.values(stream.events).some((count) => count > 1) ||
    passed + failed + skipped > 1 ||
    (started && skipped)
  ) {
    diagnostic.attribution = "ambiguous";
  } else if (stream.starts === 1 && started + passed + failed + skipped > 0) {
    diagnostic.attribution = "expected-suite";
    diagnostic.expectedQualificationStart = started === 1;
    diagnostic.expectedQualificationPass = passed === 1;
    diagnostic.expectedQualificationFail = failed === 1;
    diagnostic.expectedQualificationSkip = skipped === 1;
  }
  return diagnostic;
}

export async function runWatchQualificationCommand(
  label: string,
  bin: string,
  args: string[],
  options: CommandOptions & {
    environment: NodeJS.ProcessEnv;
    report: Record<string, unknown>;
    save: () => Promise<void>;
    signal?: AbortSignal;
  },
): Promise<{ code: number } & PhaseOutput> {
  const started = performance.now();
  const { report, save } = options;
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let parsedStderr = 0;
  let code: number | undefined;
  let childStatus: {
    label: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    outputBytes: number;
  } = { label, code: null, signal: null, outputBytes: 0 };
  const steps: BuildStep[] = [];
  const overflow = new AbortController();
  try {
    code = await runManagedCommand({
      bin,
      args,
      env: options.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: options.timeout ?? 30000,
      timeoutForceKillOnLeaderExit: true,
      requireProcessTreeExit: true,
      signal:
        options.cleanup || !options.signal
          ? overflow.signal
          : AbortSignal.any([options.signal, overflow.signal]),
      onReady(child) {
        for (const [stream, capture] of [
          [child.stdout, true],
          [child.stderr, false],
        ] as const) {
          assert(stream);
          stream.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) {
              overflow.abort();
            } else if (capture) {
              stdout += stdoutDecoder.write(chunk);
            } else if (
              label === "watch-build" ||
              /^watch-(identity|negative|positive|voice)$/.test(label)
            ) {
              stderr += stderrDecoder.write(chunk);
              if (label !== "watch-build") {
                return;
              }
              for (
                let end = stderr.indexOf("\n", parsedStderr);
                end >= 0;
                end = stderr.indexOf("\n", parsedStderr)
              ) {
                const line = stderr.slice(parsedStderr, end);
                parsedStderr = end + 1;
                const match =
                  /^OPENCLAW_WATCH_BUILD\t(start|end)\t(build-for-testing|build-settings|host-validation|install)(?:\t(\d{1,3}))?$/.exec(
                    line,
                  );
                if (
                  !match ||
                  !match[1] ||
                  !match[2] ||
                  steps.length >= 8 ||
                  (match[1] === "start") !== (match[3] === undefined) ||
                  Number(match[3] ?? 0) > 255
                ) {
                  continue;
                }
                const step = {
                  event: match[1],
                  label: match[2],
                  ...(match[3] === undefined ? {} : { code: Number(match[3]) }),
                };
                steps.push(step);
                console.log(JSON.stringify({ watchBuildStep: step }));
              }
            }
          });
        }
        child.once("exit", (exit, signal) => {
          childStatus = { label, code: exit, signal, outputBytes: bytes };
        });
        child.once("close", (exit, signal) => {
          stdout += stdoutDecoder.end();
          stderr += stderrDecoder.end();
          childStatus = { label, code: exit, signal, outputBytes: bytes };
          report.child = childStatus;
          if (!options.diagnostic) {
            console.log(JSON.stringify(childStatus));
          }
          void save().catch(() => {});
        });
      },
    });
    assert(!overflow.signal.aborted && code === 0, `Command failed: ${label}`);
    return { code, stdout, stderr, truncated: overflow.signal.aborted };
  } catch (error) {
    if (error instanceof Error && /^watch-(identity|negative|positive|voice)$/.test(label)) {
      Object.assign(error, { phaseOutput: { stdout, stderr, truncated: overflow.signal.aborted } });
    }
    // Preserve the first command failure before cleanup changes report.child.
    if (report.failedChild === undefined) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      report.failedChild = {
        ...childStatus,
        outputBytes: bytes,
        outcome: code === undefined ? "rejected" : childStatus.signal ? "signal" : "exit",
        errorCode: [
          "ETIMEDOUT",
          "ABORT_ERR",
          "ENOENT",
          "EACCES",
          "EPERM",
          "EPROCESSGROUP_CLEANUP_FAILED",
        ].includes(errorCode ?? "")
          ? errorCode
          : null,
        elapsedMs: Math.round(performance.now() - started),
        unjoined: hasUnjoinedWork(error),
        ...(label === "watch-build"
          ? {
              build: {
                steps: [...steps],
                stdout: publicBuildOutput(
                  overflow.signal.aborted ? stdout.slice(0, stdout.lastIndexOf("\n") + 1) : stdout,
                ),
                stderr: publicBuildOutput(
                  overflow.signal.aborted ? stderr.slice(0, stderr.lastIndexOf("\n") + 1) : stderr,
                ),
                truncated: overflow.signal.aborted || stdout.length > 4096 || stderr.length > 4096,
              },
            }
          : {}),
      };
      if (!options.diagnostic) {
        console.log(JSON.stringify({ failedChild: report.failedChild }));
      }
      await save().catch(() => {});
    }
    throw error;
  } finally {
    if (label === "watch-identity") {
      report.identityOutput = identityOutput(stdout, stderr, overflow.signal.aborted);
      console.log(JSON.stringify({ identityOutput: report.identityOutput }));
      await save().catch(() => {});
    }
  }
}
type Delivery = { route: string; status: number; tls: string | null; connectionID?: string };
type PhaseResult = {
  run: string;
  phase: Phase;
  nonce: string;
  ok: boolean;
  ownersJoined: boolean;
  deviceID?: string;
  publicKey?: string;
  platform?: string;
  deviceFamily?: string;
  connectionID?: string;
  tokenlessHello?: boolean;
  unchangedStoredGrant?: boolean;
  untrustedCertificateRejected?: boolean;
  methods?: string[];
  voiceQualified?: boolean;
  oldConnectObserved?: boolean;
  retirementJoined?: boolean;
  freshRetirementJoined?: boolean;
  durableReplacement?: boolean;
  freshAuthenticated?: boolean;
  oldHelloOutcome?: string;
  startupOutcome?: string;
  errors?: unknown;
};
type PhaseFailure = {
  phase: Phase;
  ownersJoined: boolean;
  helperExecutionFailed: boolean;
  admissionFailure:
    | "result-missing"
    | "result-unreadable"
    | "result-invalid"
    | "run-mismatch"
    | "phase-mismatch"
    | "nonce-mismatch"
    | "owner-acknowledgement"
    | "input-consumption"
    | "native-not-ok"
    | null;
  errors: { domain: string; code: number }[];
};

async function bounded<T>(operation: Promise<T>, milliseconds = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error("Owner did not join before deadline"), {
                processTreeState: "indeterminate",
              }),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readPrivateJSON(file: string): Promise<unknown> {
  const stat = await lstat(file);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384 && (stat.mode & 0o777) === 0o600,
    "Expected bounded private regular file",
  );
  const bytes = await readFile(file);
  assert(bytes.length <= 16384);
  return JSON.parse(bytes.toString("utf8"));
}

function bridgeFingerprint(nonce: string, domain: string, values: string[]): string {
  // Shared with Swift: UTF-8, NUL-terminated fields, exact decimal dev/ino strings.
  return createHash("sha256")
    .update(["openclaw.watch.bridge.v1", nonce.toLowerCase(), domain, ...values].join("\0") + "\0")
    .digest("hex");
}

async function bridgeDirectory(nonce: string, domain: string, directory: string) {
  try {
    // stat follows aliases; inode/device values must never pass through a JS number.
    const value = await fsStat(directory, { bigint: true });
    return value.isDirectory()
      ? bridgeFingerprint(nonce, domain, [value.dev.toString(), value.ino.toString()])
      : null;
  } catch {
    return null;
  }
}

async function bridgePresence(directory: string) {
  const presence = async (name: string) => {
    try {
      return (await lstat(path.join(directory, name))).isFile() ? "present" : "other";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable";
    }
  };
  return { input: await presence("input.json"), result: await presence("result.json") };
}

function bridgeRecords(output: PhaseOutput | undefined, correlation: string) {
  type Record = { directory: string | null; home: string | null; bundle: string | null };
  const records: { consumed: Record | null; written: Record | null } = {
    consumed: null,
    written: null,
  };
  let ambiguous = output?.truncated === true;
  const pattern =
    /^OPENCLAW_WATCH_BRIDGE\t1\t(consumed|written)\t([a-f0-9]{64})\t([a-f0-9]{64}|unavailable)\t([a-f0-9]{64}|unavailable)\t([a-f0-9]{64}|unavailable)$/;
  // Recognize complete records per stream. Never invent stdout/stderr event ordering.
  for (const text of [output?.stdout ?? "", output?.stderr ?? ""]) {
    const lines = text.split("\n");
    for (const [index, raw] of lines.entries()) {
      if (!raw.startsWith("OPENCLAW_WATCH_BRIDGE")) {
        continue;
      }
      const match = pattern.exec(raw.replace(/\r$/, ""));
      if (
        index === lines.length - 1 ||
        Buffer.byteLength(raw) + 1 > 1024 ||
        !match ||
        match[2] !== correlation
      ) {
        ambiguous = true;
        continue;
      }
      const event = match[1] as "consumed" | "written";
      if (records[event]) {
        ambiguous = true;
      }
      const value = (token: string | undefined) => (token === "unavailable" ? null : token!);
      records[event] = {
        directory: value(match[3]),
        home: value(match[4]),
        bundle: value(match[5]),
      };
    }
  }
  return ambiguous
    ? { state: "ambiguous", consumed: null, written: null }
    : { state: records.consumed && records.written ? "complete" : "unavailable", ...records };
}

type WatchPhaseOwner = {
  current: { home: string; directory: string } | null;
  bundleID: string;
  evidenceDirectory: string;
  resolveContainer: () => Promise<string>;
  report: Record<string, unknown>;
};

// Successful xcodebuild alone cannot certify a phase; admission belongs to the consumed app-container request.
export async function runWatchPhase(
  phase: Phase,
  run: string,
  owner: WatchPhaseOwner,
  execute: () => Promise<void | PhaseOutput>,
  input: object = {},
): Promise<PhaseResult> {
  const original = owner.current;
  assert(original, "Watch phase has no current container");
  // Execution may relocate the container. The old locator is input/diagnostic context only.
  owner.current = null;
  const { directory } = original;
  const nonce = randomUUID();
  const request = { ...input, run, phase, nonce, expiresAt: Date.now() / 1000 + 150 };
  assert(Buffer.byteLength(JSON.stringify(request)) <= 16384, "Phase input exceeds bound");
  const resultFile = path.join(directory, "result.json");
  await rm(resultFile, { force: true });
  await writeFile(path.join(directory, "input.json"), JSON.stringify(request), {
    mode: 0o600,
    flag: "wx",
  });
  const failures: unknown[] = [];
  const originalHome = await realpath(original.home).catch(() => null);
  const beforeExecution = {
    directory: await bridgeDirectory(nonce, "directory", directory),
    home: await bridgeDirectory(nonce, "home", original.home),
    ...(await bridgePresence(directory)),
  };
  let output: PhaseOutput | undefined;
  let executionJoined = true;
  try {
    output = (await execute()) || undefined;
  } catch (error) {
    failures.push(error);
    executionJoined = !hasUnjoinedWork(error);
    output =
      error instanceof Error
        ? (error as Error & { phaseOutput?: PhaseOutput }).phaseOutput
        : undefined;
  }
  const helperExecutionFailed = failures.length > 0;
  let query = executionJoined ? "failed" : "not-joined";
  if (executionJoined) {
    try {
      const home = await owner.resolveContainer();
      query = "invalid-container";
      assert(path.isAbsolute(home), "Expected absolute Watch container");
      const canonical = await realpath(home);
      assert((await fsStat(canonical, { bigint: true })).isDirectory(), "Invalid Watch container");
      owner.current = {
        home: canonical,
        directory: path.join(canonical, "Library", "Caches", "OpenClawQualification"),
      };
      query = "ok";
    } catch (error) {
      failures.push(error);
    }
  }
  const current = owner.current;
  let result: PhaseResult | undefined;
  let ownershipUnverified = current === null;
  let admissionFailure: PhaseFailure["admissionFailure"] = null;
  let admissionCheck: PhaseFailure["admissionFailure"] = "result-invalid";
  if (current) {
    try {
      const candidate = (await readPrivateJSON(
        path.join(current.directory, "result.json"),
      )) as PhaseResult;
      assert(candidate && typeof candidate === "object" && !Array.isArray(candidate));
      admissionCheck = "run-mismatch";
      assert.equal(candidate.run, run, "Wrong qualification run");
      admissionCheck = "phase-mismatch";
      assert.equal(candidate.phase, phase, "Wrong qualification phase");
      admissionCheck = "nonce-mismatch";
      assert.equal(candidate.nonce, nonce, "Stale qualification result");
      result = candidate;
      admissionCheck = "owner-acknowledgement";
      assert.equal(result.ownersJoined, true, "Watch async owners did not acknowledge cleanup");
      admissionCheck = "input-consumption";
      await assert.rejects(
        lstat(path.join(current.directory, "input.json")),
        { code: "ENOENT" },
        "Watch phase did not consume its input",
      );
    } catch (error) {
      // xcodebuild is not the Watch app's process owner. Missing/stale acknowledgements
      // retain the simulator/private inputs even after the managed child tree has exited.
      failures.push(error);
      ownershipUnverified = true;
      const code = (error as NodeJS.ErrnoException).code;
      admissionFailure =
        admissionCheck === "result-invalid" && code && code !== "ERR_ASSERTION"
          ? code === "ENOENT"
            ? "result-missing"
            : "result-unreadable"
          : admissionCheck;
    }
  }
  if (result) {
    try {
      assert.equal(result.ok, true, "Watch phase failed; private result retained");
    } catch (error) {
      failures.push(error);
      admissionFailure ??= "native-not-ok";
    }
  }
  // Observe the frozen result location after admission; diagnostics never select another reader.
  owner.report.phaseBridge = {
    phase,
    native: bridgeRecords(output, bridgeFingerprint(nonce, "phase", [run.toLowerCase(), phase])),
    original: {
      beforeExecution,
      afterAdmission: executionJoined
        ? {
            directory: await bridgeDirectory(nonce, "directory", directory),
            home: await bridgeDirectory(nonce, "home", original.home),
            ...(await bridgePresence(directory)),
          }
        : null,
    },
    bundle: bridgeFingerprint(nonce, "bundle", [owner.bundleID]),
    query,
    current: current
      ? {
          directory: await bridgeDirectory(nonce, "directory", current.directory),
          home: await bridgeDirectory(nonce, "home", current.home),
          ...(await bridgePresence(current.directory)),
        }
      : null,
    sameCanonicalHome:
      originalHome !== null && current !== null ? originalHome === current.home : null,
  };
  if (current) {
    try {
      const evidence = await readPrivateJSON(path.join(current.directory, "result.json"));
      await writeFile(
        path.join(owner.evidenceDirectory, `${phase}-result.json`),
        JSON.stringify(evidence),
        { mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        failures.push(error);
      }
    }
  }
  if (failures.length) {
    owner.current = null;
    // Only current, bounded results may contribute native codes to the public receipt.
    // Raw result fields and helper descriptions remain private even when cleanup is unverified.
    const phaseFailure: PhaseFailure = {
      phase,
      ownersJoined: !ownershipUnverified,
      helperExecutionFailed,
      admissionFailure,
      errors: (Array.isArray(result?.errors) ? result.errors : [])
        .slice(0, 8)
        .flatMap((failure: unknown) => {
          if (typeof failure !== "object" || failure === null) {
            return [];
          }
          const { domain, code } = failure as { domain?: unknown; code?: unknown };
          return typeof domain === "string" &&
            ["NSURLErrorDomain", "NSOSStatusErrorDomain", "other"].includes(domain) &&
            typeof code === "number" &&
            Number.isSafeInteger(code)
            ? [{ domain, code }]
            : [];
        }),
    };
    throw Object.assign(new AggregateError(failures, "Watch phase failed"), {
      phaseFailure,
      ...(ownershipUnverified ? { processTreeState: "indeterminate" } : {}),
    });
  }
  assert(result);
  return result;
}

export function createVoiceFixture(options: {
  cert: Buffer;
  key: Buffer;
  controlToken: string;
  oldToken: string;
  replacementToken: string;
  deviceID: string;
}) {
  const sockets = new Set<Socket>();
  const errors: unknown[] = [];
  const waiting = new Set<() => void>();
  const pending = new Set<Promise<void>>();
  const track = (operation: Promise<void>) => {
    const joined = operation.catch((error: unknown) => {
      errors.push(error);
    });
    pending.add(joined);
    void joined.then(() => {
      pending.delete(joined);
    });
  };
  const send = (socket: WebSocket, payload: string) => {
    track(
      new Promise<void>((resolve, reject) => {
        socket.send(payload, (error) => (error ? reject(error) : resolve()));
      }),
    );
  };
  let old: { socket: WebSocket; id: string } | undefined;
  let oldConnectObserved = false;
  let released = false;
  let freshAuthenticated = false;
  let freshSocket: WebSocket | undefined;
  let oldHelloOutcome: "held" | "sent" | "closed" = "held";
  let closing = false;
  const hello = (id: string, token?: string) =>
    JSON.stringify({
      type: "res",
      id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        server: { version: "qualification", connId: randomUUID() },
        features: { methods: ["agents.list"], events: [] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        policy: { maxPayload: 65536, maxBufferedBytes: 65536, tickIntervalMs: 30000 },
        auth: { role: "operator", scopes, ...(token ? { deviceToken: token } : {}) },
      },
    });
  const server = createHTTPSServer(
    { cert: options.cert, key: options.key, minVersion: "TLSv1.3" },
    (request, response) => {
      if (
        closing ||
        request.method !== "GET" ||
        request.headers.authorization !== `Bearer ${options.controlToken}`
      ) {
        response.writeHead(403).end();
        return;
      }
      const reply = (value: object) =>
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (request.url === "/connected" || request.url === "/fresh") {
        const isFresh = request.url === "/fresh";
        const complete = () => {
          if (!closing && !(isFresh ? freshAuthenticated : oldConnectObserved) && !expired) {
            return;
          }
          clearTimeout(timer);
          waiting.delete(complete);
          if (!response.destroyed) {
            reply(isFresh ? { freshAuthenticated } : { oldConnectObserved });
          }
        };
        let expired = false;
        const timer = setTimeout(() => {
          expired = true;
          complete();
        }, 20000);
        waiting.add(complete);
        response.once("close", () => {
          clearTimeout(timer);
          waiting.delete(complete);
        });
        complete();
      } else if (request.url === "/release" && old && !released) {
        released = true;
        if (old.socket.readyState === WebSocket.OPEN) {
          track(
            new Promise<void>((resolve) => {
              old!.socket.send(hello(old!.id, options.oldToken), (error) => {
                if (error) {
                  errors.push(error);
                  response.writeHead(500).end();
                } else {
                  oldHelloOutcome = "sent";
                  reply({ oldHelloOutcome });
                }
                resolve();
              });
            }),
          );
        } else {
          const closed =
            old.socket.readyState === WebSocket.CLOSED
              ? Promise.resolve()
              : new Promise<void>((resolve) => {
                  old!.socket.once("close", resolve);
                });
          track(
            bounded(closed)
              .then(() => {
                oldHelloOutcome = "closed";
                reply({ oldHelloOutcome });
              })
              .catch((error: unknown) => {
                errors.push(error);
                response.writeHead(500).end();
              }),
          );
        }
      } else if (request.url === "/status") {
        reply({ freshAuthenticated, oldHelloOutcome });
      } else {
        response.writeHead(409).end();
      }
    },
  );
  server.requestTimeout = 25000;
  server.headersTimeout = 10000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  server.on("error", (error) => errors.push(error));
  const wss = new WebSocketServer({ server, maxPayload: 16384, perMessageDeflate: false });
  wss.on("error", (error) => errors.push(error));
  wss.on("connection", (socket, request) => {
    if (closing || request.url !== "/" || wss.clients.size > 2) {
      socket.terminate();
      return;
    }
    socket.on("error", (error) => errors.push(error));
    send(
      socket,
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: randomUUID(), ts: Date.now() },
      }),
    );
    socket.on("message", (bytes, binary) => {
      if (closing) {
        socket.terminate();
        return;
      }
      try {
        assert(!binary);
        const data = Buffer.isBuffer(bytes)
          ? bytes
          : Array.isArray(bytes)
            ? Buffer.concat(bytes)
            : Buffer.from(bytes);
        const frame = JSON.parse(data.toString("utf8"));
        assert.equal(frame.type, "req");
        if (socket === freshSocket) {
          assert.equal(frame.method, "agents.list");
          assert(!freshAuthenticated);
          freshAuthenticated = true;
          for (const complete of waiting) {
            complete();
          }
          return;
        }
        assert.equal(frame.method, "connect");
        assert.equal(typeof frame.id, "string");
        assert.equal(frame.params.device.id, options.deviceID);
        assert.equal(frame.params.role, "operator");
        assert(frame.params.minProtocol <= 4 && frame.params.maxProtocol >= 4);
        assert.deepEqual(frame.params.scopes, scopes);
        const token = frame.params.auth?.deviceToken ?? frame.params.auth?.token;
        if (!old) {
          assert.equal(token, options.oldToken);
          old = { socket, id: frame.id };
          oldConnectObserved = true;
          for (const complete of waiting) {
            complete();
          }
        } else {
          assert(released && socket !== old.socket && !freshSocket);
          assert.equal(token, options.replacementToken);
          freshSocket = socket;
          // Tokenless fresh hello must not rewrite the replacement grant.
          send(socket, hello(frame.id));
        }
      } catch {
        errors.push(new Error("Unexpected voice fixture frame"));
        socket.terminate();
      }
    });
  });
  return {
    async listen() {
      await bounded(
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        }),
      );
      const address = server.address();
      assert(address && typeof address !== "string");
      return `https://localhost:${address.port}`;
    },
    snapshot() {
      return { oldConnectObserved, oldHelloOutcome, freshAuthenticated };
    },
    async close() {
      closing = true;
      for (const complete of waiting) {
        complete();
      }
      const failures: unknown[] = [];
      // ws does not close an externally supplied HTTPS server. Join both owners,
      // including accepted non-WebSocket sockets, before releasing private inputs.
      try {
        const joined = new Promise<void>((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()));
        });
        for (const client of wss.clients) {
          client.terminate();
        }
        await bounded(joined);
        assert.equal(wss.clients.size, 0);
      } catch (error) {
        failures.push(error);
      }
      try {
        const joined = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        const closed = [...sockets].map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket.once("close", resolve);
            }),
        );
        for (const socket of sockets) {
          socket.destroy();
        }
        await bounded(Promise.all([joined, ...closed]));
        assert.equal(sockets.size, 0);
      } catch (error) {
        failures.push(error);
      }
      try {
        await bounded(Promise.all(pending));
        assert.equal(pending.size, 0);
        assert.equal(waiting.size, 0);
      } catch (error) {
        failures.push(error);
      }
      failures.push(...errors);
      if (failures.length) {
        throw new AggregateError(failures, "Voice fixture cleanup failed");
      }
    },
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function main(): Promise<void> {
  assert(
    process.platform === "darwin" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "Watch qualification requires a disposable GitHub-hosted macOS workflow_dispatch runner",
  );
  assert((await lstat(developerDirectory)).isDirectory(), "Approved Xcode is absent");
  process.umask(0o077);
  const run = randomUUID();
  const runnerTemp = await realpath(process.env.RUNNER_TEMP!);
  const output = path.join(runnerTemp, "watch-qualification");
  const privateRoot = path.join(runnerTemp, `watch-https-private-${run}`);
  const buildState = path.join(privateRoot, "build");
  const gatewayState = path.join(privateRoot, "gateway");
  const home = path.join(privateRoot, "home");
  await mkdir(output, { recursive: true });
  await mkdir(privateRoot, { mode: 0o700 });
  await Promise.all([buildState, gatewayState, home].map((dir) => mkdir(dir, { mode: 0o700 })));
  const nativeEnvironment = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  nativeEnvironment.DEVELOPER_DIR = developerDirectory;
  // Gateway state is isolated before runtime imports. Native tools keep their actual
  // simulator-service HOME; neither environment inherits credentials or proxy settings.
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, {
    PATH: nativeEnvironment.PATH,
    TMPDIR: nativeEnvironment.TMPDIR,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    OPENCLAW_STATE_DIR: gatewayState,
    OPENCLAW_CONFIG_PATH: path.join(gatewayState, "openclaw.json"),
  });
  const started = performance.now();
  const report: Record<string, unknown> = { ok: false, https: { ok: false }, voice: { ok: false } };
  const receipt = path.join(output, "operator-https.json");
  let writes = Promise.resolve();
  let receiptFailed = false;
  const save = () => {
    const snapshot = JSON.stringify(report, null, 2) + "\n";
    const pending = writes.then(async () => {
      await writeFile(`${receipt}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${receipt}.tmp`, receipt);
    });
    writes = pending.catch(() => {
      receiptFailed = true;
    });
    return pending;
  };
  let stage = "initialize";
  const checkpoint = async (next: string) => {
    stage = next;
    report.progress = { stage, elapsedMs: Math.round(performance.now() - started) };
    console.log(JSON.stringify(report.progress));
    await save();
  };
  const errors: unknown[] = [];
  const runCommand: RunCommand = async (label, bin, args, options = {}) => {
    if (options.cleanup) {
      await checkpoint(label).catch(() => {});
    } else {
      await checkpoint(label);
    }
    return runWatchQualificationCommand(label, bin, args, {
      ...options,
      environment: nativeEnvironment,
      signal: cancelled.signal,
      report,
      save,
    });
  };
  let simulator: string | undefined;
  let gateway:
    | Awaited<ReturnType<typeof import("../src/gateway/server.js").startGatewayServer>>
    | undefined;
  let voice: ReturnType<typeof createVoiceFixture> | undefined;
  let port = 0;
  const deliveries: Delivery[] = [];
  let deliveryOverflow = false;
  const responseFinish = channel("http.server.response.finish");
  const observe = (message: unknown) => {
    const { request, response, socket } = message as {
      request: IncomingMessage;
      response: ServerResponse;
      socket: TLSSocket;
    };
    if (!(socket instanceof TLSSocket) || socket.localPort !== port) {
      return;
    }
    const match = /^\/api\/operator\/connections(?:\/([^/?]+)(?:\/(frames|poll))?)?$/.exec(
      request.url ?? "",
    );
    if (!match) {
      return;
    }
    if (deliveries.length >= 128) {
      deliveryOverflow = true;
      return;
    }
    deliveries.push({
      route: request.method === "DELETE" ? "delete" : (match[2] ?? "begin"),
      status: response.statusCode,
      tls: socket.getProtocol(),
      connectionID: match[1],
    });
  };
  const interrupt = () => cancelled.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let httpsPassed = false;
  let voicePassed = false;
  try {
    const sdkVersion = (
      await runCommand("watch-sdk", "xcrun", ["--sdk", "watchsimulator", "--show-sdk-version"])
    ).stdout.trim();
    assert(/^\d+\.\d+(?:\.\d+)?$/.test(sdkVersion), "Invalid selected Watch simulator SDK version");
    report.watchSDK = sdkVersion;
    const runtimes = JSON.parse(
      (await runCommand("watch-runtimes", "xcrun", ["simctl", "list", "runtimes", "--json"]))
        .stdout,
    ).runtimes as { identifier: string; isAvailable: boolean; version: string }[];
    const runtime = runtimes.find(
      (value) =>
        value.isAvailable &&
        value.version === sdkVersion &&
        value.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.watchOS-"),
    );
    assert(runtime, `Available watchOS ${sdkVersion} runtime matching the selected SDK is absent`);
    const types = JSON.parse(
      (await runCommand("watch-device-types", "xcrun", ["simctl", "list", "devicetypes", "--json"]))
        .stdout,
    ).devicetypes as {
      identifier: string;
      productFamily: string;
      minRuntimeVersion: number;
      maxRuntimeVersion: number;
    }[];
    // simctl packs major, minor, and patch into successive bytes.
    const version = sdkVersion
      .split(".")
      .reduce((total, part, index) => total + Number(part) * 256 ** (2 - index), 0);
    const device = types.find(
      (value) =>
        value.productFamily === "Apple Watch" &&
        value.minRuntimeVersion <= version &&
        value.maxRuntimeVersion >= version,
    );
    assert(device, "No compatible Watch device type");
    const created = await runCommand("watch-create", "xcrun", [
      "simctl",
      "create",
      `OpenClaw qualification ${run}`,
      device.identifier,
      runtime.identifier,
    ]);
    simulator = created.stdout.trim();
    assert(/^[0-9a-f-]{36}$/i.test(simulator), "Missing owned simulator identity");
    await runCommand("watch-boot", "xcrun", ["simctl", "boot", simulator]);
    await runCommand("watch-ready", "xcrun", ["simctl", "bootstatus", simulator, "-b"], {
      timeout: 120000,
    });
    const helper = (phase: string) =>
      runCommand(
        `watch-${phase}`,
        "/bin/bash",
        [
          "scripts/ios-watch-operation-tests.sh",
          path.join(privateRoot, `${phase}.xcresult`),
          simulator!,
          phase,
          buildState,
        ],
        { timeout: phase === "build" ? 300000 : 90000 },
      );
    await helper("build");
    const build = (await readPrivateJSON(path.join(buildState, "build.json"))) as {
      simulator: string;
      bundleID: string;
    };
    assert.equal(build.simulator, simulator);
    assert(typeof build.bundleID === "string" && /^[A-Za-z0-9.-]+$/.test(build.bundleID));
    const container = (
      await runCommand("watch-container", "xcrun", [
        "simctl",
        "get_app_container",
        simulator,
        build.bundleID,
        "data",
      ])
    ).stdout.trim();
    assert(path.isAbsolute(container) && (await lstat(container)).isDirectory());
    const directory = path.join(
      await realpath(container),
      "Library",
      "Caches",
      "OpenClawQualification",
    );
    await mkdir(directory, { mode: 0o700 });
    const phaseOwner: WatchPhaseOwner = {
      current: { home: container, directory },
      bundleID: build.bundleID,
      evidenceDirectory: privateRoot,
      report,
      resolveContainer: async () => {
        // Same owned device and verified bundle, once, after the phase child joins.
        const observed = await runWatchQualificationCommand(
          "watch-container-post",
          "xcrun",
          ["simctl", "get_app_container", simulator!, build.bundleID, "data"],
          {
            environment: nativeEnvironment,
            signal: cancelled.signal,
            report: {},
            save: async () => {},
            diagnostic: true,
          },
        );
        return observed.stdout.trim();
      },
    };
    const phase = async (value: Phase, input?: object) => {
      try {
        return await runWatchPhase(
          value,
          run,
          phaseOwner,
          async () => {
            const commandResult = await helper(value);
            assert.equal(commandResult.code, 0);
            return commandResult;
          },
          input,
        );
      } catch (error) {
        const diagnostic = (error as { phaseFailure?: PhaseFailure }).phaseFailure;
        if (diagnostic) {
          report.phaseFailure = diagnostic;
        }
        throw error;
      }
    };
    const identity = await phase("identity");
    assert(identity.deviceID && identity.publicKey && identity.platform && identity.deviceFamily);
    const ca = path.join(privateRoot, "ca.pem");
    const caKey = path.join(privateRoot, "ca.key");
    const key = path.join(privateRoot, "leaf.key");
    const csr = path.join(privateRoot, "leaf.csr");
    const cert = path.join(privateRoot, "leaf.pem");
    const ext = path.join(privateRoot, "leaf.ext");
    await runCommand("certificate-ca", "openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=OpenClaw Watch qualification",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      caKey,
      "-out",
      ca,
    ]);
    await runCommand("certificate-request", "openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      "/CN=localhost",
      "-keyout",
      key,
      "-out",
      csr,
    ]);
    await writeFile(
      ext,
      "basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n" +
        "keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
    );
    await runCommand("certificate-sign", "openssl", [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      ext,
      "-out",
      cert,
    ]);
    port = await reservePort();
    await writeFile(
      process.env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth: { mode: "token", token: randomBytes(32).toString("base64url") },
          tailscale: { mode: "off" },
          controlUi: { enabled: false },
          tls: { enabled: true, autoGenerate: false, certPath: cert, keyPath: key, caPath: ca },
        },
        agents: { list: [{ id: "proof", workspace: path.join(privateRoot, "workspace") }] },
        logging: {
          level: "silent",
          consoleLevel: "silent",
          file: path.join(privateRoot, "gateway.log"),
        },
      }),
    );
    await checkpoint("gateway-pairing");
    const { requestDevicePairing, getPairedDevice } =
      await import("../src/infra/device-pairing.js");
    const { approveDevicePairing } = await import("../src/infra/device-pairing-approval.js");
    const request = await requestDevicePairing(
      {
        deviceId: identity.deviceID,
        publicKey: identity.publicKey,
        platform: identity.platform,
        deviceFamily: identity.deviceFamily,
        clientId: "openclaw-watchos",
        clientMode: "node",
        role: "operator",
        scopes,
      },
      gatewayState,
    );
    const approved = await approveDevicePairing(
      request.request.requestId,
      { callerScopes: scopes, approvedVia: "owner" },
      gatewayState,
    );
    assert(approved?.status === "approved");
    const grant = approved.device.tokens?.operator;
    assert(grant?.token && grant.role === "operator");
    assert.deepEqual(grant.scopes, scopes);
    const paired = await getPairedDevice(identity.deviceID, gatewayState);
    assert.equal(paired?.approvedVia, "owner");
    assert.equal(paired?.tokens?.operator?.token, grant.token);
    await checkpoint("gateway-start");
    const { startGatewayServer } = await import("../src/gateway/server.js");
    gateway = await bounded(startGatewayServer(port, { host: "127.0.0.1", updateCanary: true }));
    await bounded(gateway.startupSettled);
    responseFinish.subscribe(observe);
    const input = {
      endpoint: `https://localhost:${port}`,
      gatewayID: `watch-direct:https://localhost:${port}`,
      deviceID: identity.deviceID,
      token: grant.token,
    };
    const negative = await phase("negative", input);
    assert.equal(negative.untrustedCertificateRejected, true);
    assert.equal(negative.unchangedStoredGrant, true);
    assert.equal(deliveries.length, 0, "Operator HTTP reached Gateway before simulator trust");
    report.negative = {
      untrustedCertificateRejected: true,
      unchangedStoredGrant: true,
      operatorResponses: 0,
    };
    await save();
    await runCommand("watch-trust-install", "xcrun", [
      "simctl",
      "keychain",
      simulator,
      "add-root-cert",
      ca,
    ]);
    const positive = await phase("positive", input);
    assert.equal(positive.tokenlessHello, true);
    assert.equal(positive.unchangedStoredGrant, true);
    assert.deepEqual(positive.methods, ["agents.list", "sessions.list"]);
    assert(positive.connectionID && !deliveryOverflow);
    assert.equal(
      deliveries.filter((event) => event.route === "begin" && event.status === 201).length,
      1,
    );
    assert(deliveries.every((event) => event.tls === "TLSv1.3"));
    assert(deliveries.some((event) => event.route === "frames" && event.status === 202));
    assert(deliveries.some((event) => event.route === "poll" && event.status === 200));
    assert(
      deliveries.some(
        (event) =>
          event.route === "delete" &&
          event.status === 204 &&
          event.connectionID === positive.connectionID,
      ),
      "No completed DELETE for the Watch actor connection",
    );
    httpsPassed = true;
    report.https = {
      ok: true,
      tokenlessHello: true,
      unchangedStoredGrant: true,
      methods: positive.methods,
      responses: deliveries.map(({ route, status, tls }) => ({ route, status, tls })),
    };
    await save();
    const voiceInput = {
      controlToken: randomBytes(32).toString("base64url"),
      oldToken: randomBytes(32).toString("base64url"),
      replacementToken: randomBytes(32).toString("base64url"),
      deviceID: identity.deviceID,
    };
    voice = createVoiceFixture({
      ...voiceInput,
      cert: await readFile(cert),
      key: await readFile(key),
    });
    const endpoint = await voice.listen();
    // Permission provisioning is not proof of successful audio activation.
    await runCommand("watch-microphone-permission", "xcrun", [
      "simctl",
      "privacy",
      simulator,
      "grant",
      "microphone",
      build.bundleID,
    ]);
    const result = await phase("voice", {
      ...voiceInput,
      endpoint,
      gatewayID: `watch-direct:${endpoint}`,
      token: voiceInput.oldToken,
    });
    const observedVoice = voice.snapshot();
    if (result.voiceQualified) {
      assert.equal(result.oldHelloOutcome, observedVoice.oldHelloOutcome);
      assert(["sent", "closed"].includes(observedVoice.oldHelloOutcome));
    }
    voicePassed =
      result.voiceQualified === true &&
      result.retirementJoined === true &&
      result.freshRetirementJoined === true &&
      result.durableReplacement === true &&
      result.freshAuthenticated === true &&
      observedVoice.freshAuthenticated;
    report.voice = {
      ok: voicePassed,
      ...observedVoice,
      retirementJoined: result.retirementJoined === true,
      freshRetirementJoined: result.freshRetirementJoined === true,
      durableReplacement: result.durableReplacement === true,
      startupOutcome: result.startupOutcome ?? null,
    };
    await save();
  } catch (error) {
    errors.push(error);
    report.failureStage = stage;
    if (
      simulator &&
      ["watch-boot", "watch-ready"].includes(stage) &&
      !cancelled.signal.aborted &&
      !hasUnjoinedWork(error)
    ) {
      try {
        const inventory = await runCommand("watch-state", "xcrun", ["simctl", "list", "--json"], {
          diagnostic: true,
        });
        report.simulatorAfterFailure = observeOwnedWatchSimulator(
          JSON.parse(inventory.stdout),
          simulator,
        );
      } catch (observationError) {
        // Preserve unjoined-child fencing during cleanup; failedChild and
        // failureStage already retain the original boot/readiness failure.
        errors.push(observationError);
        report.simulatorAfterFailure = { unavailable: true };
      }
    }
  } finally {
    const cleanupFailures: string[] = [];
    const cleanup = async (name: string, operation: () => Promise<unknown>) => {
      await checkpoint(name).catch(() => {});
      try {
        await operation();
      } catch (error) {
        errors.push(error);
        cleanupFailures.push(name);
      }
    };
    if (voice) {
      await cleanup("voice-fixture-close", () => voice!.close());
    }
    if (gateway) {
      await cleanup("gateway-close", () =>
        bounded(
          gateway!.close({
            reason: "qualification complete",
            drainTimeoutMs: 1000,
          }),
        ),
      );
    }
    responseFinish.unsubscribe(observe);
    // A failed child/socket owner still holds its simulator and private inputs.
    // Never use global shutdown/reset or delete devices not returned by this run's create.
    if (simulator && !errors.some(hasUnjoinedWork)) {
      await cleanup("watch-shutdown", () =>
        runCommand("watch-shutdown", "xcrun", ["simctl", "shutdown", simulator!], {
          cleanup: true,
        }),
      );
      if (cleanupFailures.length === 0) {
        await cleanup("watch-delete", async () => {
          await runCommand("watch-delete", "xcrun", ["simctl", "delete", simulator!], {
            cleanup: true,
          });
          const devices = JSON.parse(
            (
              await runCommand(
                "watch-delete-verify",
                "xcrun",
                ["simctl", "list", "devices", "--json"],
                { cleanup: true },
              )
            ).stdout,
          ).devices as Record<string, { udid: string }[]>;
          assert(
            !Object.values(devices)
              .flat()
              .some((device) => device.udid === simulator),
          );
          report.simulatorDeleted = true;
        });
      }
    }
    report.unjoined = errors.some(hasUnjoinedWork);
    report.privateStateRetained = true;
    await writes;
    if (
      errors.length === 0 &&
      !receiptFailed &&
      httpsPassed &&
      voicePassed &&
      !cancelled.signal.aborted
    ) {
      await cleanup("private-state-removal", async () => {
        await rm(privateRoot, { recursive: true });
        report.privateStateRetained = false;
      });
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await writes;
    report.cleanupFailures = cleanupFailures;
    report.receiptWriteFailed = receiptFailed;
    report.ok =
      httpsPassed &&
      voicePassed &&
      errors.length === 0 &&
      !receiptFailed &&
      !cancelled.signal.aborted;
    await save();
  }
  assert.equal(report.ok, true, "Watch qualification incomplete; see operator-https.json");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
