import type { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { QaSuiteInfraError } from "./errors.js";
import {
  cleanupQaGatewayTempRoots,
  preserveQaGatewayDebugArtifacts,
} from "./gateway-child-artifacts.js";
import { closeQaGatewayLogStream, stopQaGatewayChildProcessTree } from "./gateway-child-process.js";
import { createQaGatewayCliError } from "./gateway-log-redaction.js";
import type { reserveQaGatewayPort } from "./gateway-port-reservation.js";
import type {
  createQaGatewayProcessBoundaryController,
  QaGatewayVerifiedProcessIdentity,
} from "./gateway-process-boundary.js";
import type { startQaGatewayRpcClient } from "./gateway-rpc-client.js";

type BoundaryController = Awaited<ReturnType<typeof createQaGatewayProcessBoundaryController>>;
type PreparedSpawn = Awaited<ReturnType<BoundaryController["prepare"]>>;
const QA_GATEWAY_CHILD_DRAIN_TIMEOUT_MS = 1_000;

export type QaGatewayStopResult = {
  process: "never-spawned" | "confirmed-stopped" | "unconfirmed";
  errors: unknown[];
};
export type QaGatewayStopOptions = { keepTemp?: boolean; preserveToDir?: string };

type OwnedProcess = {
  kind: "gateway" | "cli";
  child: ChildProcess;
  prepared: PreparedSpawn | null;
  identity: QaGatewayVerifiedProcessIdentity | null;
  settlement?: Promise<QaGatewayStopResult>;
  stopResult?: QaGatewayStopResult;
  completion?: Promise<void>;
  closed: Promise<void>;
  ready: boolean;
  checkFailure: () => void;
};

// One lifetime owns staging, every spawn (including unaccepted launchers), and
// teardown. Diagnostic failures never substitute for process-group settlement.
export class QaGatewayChildLifecycle {
  tempRoot: string | null = null;
  stagedBundledPluginsRoot: string | null = null;
  portReservation: Awaited<ReturnType<typeof reserveQaGatewayPort>> | null = null;
  controller: BoundaryController | null = null;
  rpcClient: Awaited<ReturnType<typeof startQaGatewayRpcClient>> | null = null;
  readonly logStreams: Array<["stdout" | "stderr", WriteStream]> = [];
  private readonly cancellation = new AbortController();
  private readonly processes = new Set<OwnedProcess>();
  private spawned = false;
  private current: OwnedProcess | null = null;
  private operation: Promise<unknown> | null = null;
  private stopping: Promise<QaGatewayStopResult> | null = null;
  private artifactsFinalized = false;
  private tempRootsCleaned = false;
  private readonly keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1";

  repoRoot?: string;

  get signal() {
    return this.cancellation.signal;
  }

  assertOpen() {
    if (this.signal.aborted) {
      throw new Error("qa gateway child lifecycle is closed");
    }
  }

  register(
    child: ChildProcess,
    prepared: PreparedSpawn | null,
    kind: OwnedProcess["kind"] = "gateway",
  ) {
    // Capture close synchronously; even a failed spawn must settle its pipes
    // before teardown can finalize their log sinks.
    const owned: OwnedProcess = {
      child,
      prepared,
      kind,
      identity: null,
      closed: new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      }),
      ready: false,
      checkFailure: () => {},
    };
    if (kind === "gateway") {
      if (this.current?.stopResult?.process === "confirmed-stopped") {
        this.processes.delete(this.current);
      }
      this.current = owned;
    }
    this.spawned ||= child.pid !== undefined;
    this.processes.add(owned);
    return owned;
  }

  async waitForClose(owned: OwnedProcess) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        owned.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const label = owned.kind === "cli" ? "CLI" : "child";
            reject(
              new Error(`qa gateway ${label} stdio did not close after process-tree shutdown`),
            );
          }, QA_GATEWAY_CHILD_DRAIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  completeCli(owned: OwnedProcess, operation: Promise<string>) {
    owned.completion = operation
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        if (owned.stopResult?.process === "confirmed-stopped") {
          this.processes.delete(owned);
        }
      });
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.operation) {
      throw new Error("qa gateway child lifecycle operation already in progress");
    }
    const pending = Promise.resolve().then(() => {
      this.assertOpen();
      return operation();
    });
    this.operation = pending;
    try {
      return await pending;
    } catch (error) {
      this.cancellation.abort();
      // Settle the failed operation's process, but leave logs and staging owned
      // until explicit stop supplies the caller's artifact preservation policy.
      const result = await this.stopAllProcesses();
      const message = `${formatErrorMessage(error)}${this.tempRoot ? `\nQA gateway temp root preserved at ${this.tempRoot}` : ""}`;
      const primary =
        error instanceof QaSuiteInfraError
          ? new QaSuiteInfraError(error.code, message, { cause: error })
          : new Error(message, { cause: error });
      if (result.errors.length) {
        // AggregateError retains the primary failure as cause and every cleanup failure in errors.
        const aggregate = new AggregateError(
          [primary, ...result.errors],
          "qa gateway startup and cleanup failed",
        );
        aggregate.cause = error;
        throw aggregate;
      }
      throw primary;
    } finally {
      this.operation = null;
    }
  }

  stopProcess(current = this.current) {
    if (!current) {
      return Promise.resolve<QaGatewayStopResult>({ process: "never-spawned", errors: [] });
    }
    // Cache settlement for this exact spawn; retries/replacements install a new
    // record only after confirmed termination, never after a leader-only exit.
    current.settlement ??= (async (): Promise<QaGatewayStopResult> => {
      const errors: unknown[] = [];
      if (current.kind === "gateway" && this.controller) {
        try {
          if (current.identity) {
            await this.controller.markExited(current.identity);
          } else if (current.prepared) {
            await this.controller.abort({ child: current.child, prepared: current.prepared });
          }
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await stopQaGatewayChildProcessTree(
          current.child,
          !current.ready
            ? {
                gracefulTimeoutMs: 1_500,
                forceTimeoutMs: 1_500,
              }
            : undefined,
        );
        if (current.kind === "gateway") {
          // Group quiescence can precede the owned child's pipe drain. Join it
          // before replacement, log finalization, or state removal can proceed.
          await this.waitForClose(current);
        }
        return { process: "confirmed-stopped", errors };
      } catch (error) {
        const failure = current.kind === "cli" ? createQaGatewayCliError(error) : error;
        return { process: "unconfirmed", errors: [...errors, failure] };
      }
    })().then((result) => {
      current.stopResult = result;
      return result;
    });
    return current.settlement;
  }

  stop(opts?: QaGatewayStopOptions): Promise<QaGatewayStopResult> {
    // Close admission before any await: staging/acceptance/replacement cannot
    // spawn or resume a child after a caller has requested stop.
    this.cancellation.abort();
    const existingStopping = this.stopping;
    const stopping = (this.stopping ??= this.stopOnce(opts).then((result) => {
      if (result.errors.length) {
        this.stopping = null;
      }
      return result;
    }));
    const keepTemp = opts?.keepTemp ?? this.keepTemp;
    if (keepTemp || !existingStopping) {
      return stopping;
    }
    return stopping.then(async (stopped) => {
      const errors = [...stopped.errors];
      await this.finalizeRetainedArtifacts(stopped, opts, errors);
      return { process: stopped.process, errors };
    });
  }

  private async stopOnce(opts?: QaGatewayStopOptions): Promise<QaGatewayStopResult> {
    for (const owned of this.processes) {
      if (owned.stopResult?.process === "unconfirmed") {
        owned.settlement = undefined;
        owned.stopResult = undefined;
      }
    }
    await this.stopAllProcesses();
    await this.operation?.catch(() => {});
    return this.finish(opts);
  }

  private async stopAllProcesses(): Promise<QaGatewayStopResult> {
    const results = await Promise.all(
      [...this.processes].map(async (owned) => {
        const result = await this.stopProcess(owned);
        await owned.completion;
        return result;
      }),
    );
    return {
      process: results.some((result) => result.process === "unconfirmed")
        ? "unconfirmed"
        : this.spawned
          ? "confirmed-stopped"
          : "never-spawned",
      errors: results.flatMap((result) => result.errors),
    };
  }

  private async finish(opts?: QaGatewayStopOptions): Promise<QaGatewayStopResult> {
    const stopped = await this.stopAllProcesses();
    const errors = [...stopped.errors];
    const attempt = async (cleanup: () => Promise<unknown>) => {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(async () => this.portReservation?.release());
    await attempt(async () => this.rpcClient?.stop());
    // A surviving group can still write through inherited pipes. Keep its log
    // sinks owned until settlement; closing them early turns output into errors.
    if (stopped.process !== "unconfirmed") {
      for (const [label, stream] of this.logStreams) {
        await attempt(() => closeQaGatewayLogStream(stream, label));
      }
    }
    await attempt(async () => this.current?.checkFailure());
    await this.finalizeRetainedArtifacts(stopped, opts, errors);
    return { process: stopped.process, errors };
  }

  private async finalizeRetainedArtifacts(
    stopped: QaGatewayStopResult,
    opts: QaGatewayStopOptions | undefined,
    errors: unknown[],
  ): Promise<void> {
    const tempRoot = this.tempRoot;
    const keepTemp = opts?.keepTemp ?? this.keepTemp;
    let artifactsPreserved = true;
    if (tempRoot && opts?.preserveToDir && !keepTemp && !this.artifactsFinalized) {
      try {
        await preserveQaGatewayDebugArtifacts({
          preserveToDir: opts.preserveToDir,
          stdoutLogPath: path.join(tempRoot, "gateway.stdout.log"),
          stderrLogPath: path.join(tempRoot, "gateway.stderr.log"),
          tempRoot,
          repoRoot: this.repoRoot,
        });
      } catch (error) {
        artifactsPreserved = false;
        errors.push(
          new Error(`${formatErrorMessage(error)}\nQA gateway temp root preserved at ${tempRoot}`, {
            cause: error,
          }),
        );
      }
    }
    if (tempRoot && stopped.process !== "unconfirmed" && artifactsPreserved && !keepTemp) {
      await this.cleanupRetainedTempRoots(errors);
    }
  }

  private async cleanupRetainedTempRoots(errors: unknown[]): Promise<void> {
    const tempRoot = this.tempRoot;
    if (!tempRoot || this.tempRootsCleaned) {
      return;
    }
    // Finalize artifact policy before cleanup can delete its log sources.
    // Unconfirmed stops must keep refreshing their still-writable snapshots.
    this.artifactsFinalized = true;
    try {
      await cleanupQaGatewayTempRoots({
        tempRoot,
        stagedBundledPluginsRoot: this.stagedBundledPluginsRoot,
        // The isolation owner created private directories under another UID.
        // Finalize them only after shutdown and sanitized log preservation.
        cleanupTempRoot: this.controller?.cleanupTempRoot,
      });
      this.tempRootsCleaned = true;
    } catch (error) {
      errors.push(error);
    }
  }
}
