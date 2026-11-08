import type { Readable } from "node:stream";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runOutsideCommandProcessScope, waitForCommandSpawn } from "../../process/exec-spawn.js";
import { isPlainCommandExitFailure, spawnCommand } from "../../process/exec.js";
import { runWithSpawnBroker } from "../../process/spawn-broker/context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { sleep } from "../../utils/sleep.js";
import { execContainer, type SandboxContainerEngine } from "./container-engine.js";
import {
  assertDockerPersistentTargetCurrent,
  readDockerPersistentContainer,
} from "./docker-persistent-target.js";
import {
  dockerPersistentExecContainerName,
  parseDockerPersistentExecReceipt,
  parseDockerPersistentExecTarget,
  type DockerPersistentExecExtinctionProof,
  type DockerPersistentExecCleanupTarget,
  type DockerPersistentExecReceipt,
  type DockerPersistentExecTarget,
  type SandboxPersistentExecCapability,
  type SandboxPersistentExecCommand,
  type SandboxPersistentExecStopped,
} from "./persistent-exec.types.js";

const CONTROL_TIMEOUT_MS = 30_000;
const START_POLL_INTERVAL_MS = 100;
const MAX_OUTPUT_CHUNK_BYTES = 1_048_576;
const ATTEMPT_LABEL = "openclaw.persistentExecAttempt";
const PARENT_LABEL = "openclaw.persistentExecParentId";
const STORE_LABEL = "openclaw.streamStore";

type ChildContainer = {
  receipt: DockerPersistentExecReceipt;
  custodyScope: string;
  status: string;
  hasStarted: boolean;
  exitCode: number | null;
};

function captureCleanupTarget(
  input: DockerPersistentExecCleanupTarget,
): DockerPersistentExecCleanupTarget {
  dockerPersistentExecContainerName(input.attemptId);
  if (!/^[a-f0-9]{64}$/u.test(input.parentContainerId)) {
    throw new Error("Invalid original Docker sandbox identity; custody retained.");
  }
  if (input.containerId !== undefined) {
    return parseDockerPersistentExecReceipt({ ...input, version: 1 });
  }
  return {
    target: parseDockerPersistentExecTarget(input.target),
    attemptId: input.attemptId,
    parentContainerId: input.parentContainerId,
  };
}

function assertCustodyScope(scope: string): void {
  if (!/^[a-f0-9]{64}$/u.test(scope)) {
    throw new Error("Invalid sandbox stream custody scope; cleanup is not permitted.");
  }
}

const extinctionProofs = new WeakMap<
  DockerPersistentExecExtinctionProof,
  DockerPersistentExecCleanupTarget
>();

function mintExtinctionProof(
  identity: DockerPersistentExecCleanupTarget,
): DockerPersistentExecExtinctionProof {
  const proof: DockerPersistentExecExtinctionProof = Object.freeze({
    kind: "docker-container-extinction",
  });
  extinctionProofs.set(
    proof,
    Object.freeze({ ...identity, target: Object.freeze({ ...identity.target }) }),
  );
  return proof;
}

export function readDockerPersistentExecExtinctionProof(
  proof: DockerPersistentExecExtinctionProof,
): DockerPersistentExecCleanupTarget {
  const identity = extinctionProofs.get(proof);
  if (!identity) {
    throw new Error("Container extinction was not confirmed by its original Docker custody owner.");
  }
  return identity;
}

async function inspectChild(
  engine: SandboxContainerEngine,
  target: DockerPersistentExecTarget,
  identifier: string,
  signal: AbortSignal,
): Promise<ChildContainer | undefined> {
  const inspected = await execContainer(engine, ["inspect", "--format", "{{json .}}", identifier], {
    allowFailure: true,
    signal,
  });
  if (inspected.code !== 0) {
    if (
      inspected.stderr.includes(identifier) &&
      /no such (?:container|object)/iu.test(inspected.stderr)
    ) {
      return undefined;
    }
    throw new Error("Original Docker stream container cannot be inspected; custody retained.");
  }
  const value: unknown = JSON.parse(inspected.stdout);
  if (
    !isRecord(value) ||
    !isRecord(value.Config) ||
    !isRecord(value.Config.Labels) ||
    !isRecord(value.State)
  ) {
    throw new Error("Docker stream container identity is unreadable; custody retained.");
  }
  const receipt = parseDockerPersistentExecReceipt({
    version: 1,
    target,
    containerId: value.Id,
    attemptId: value.Config.Labels[ATTEMPT_LABEL],
    parentContainerId: value.Config.Labels[PARENT_LABEL],
  });
  const custodyScope = value.Config.Labels[STORE_LABEL];
  if (typeof custodyScope !== "string") {
    throw new Error("Docker stream container has no recorded custody scope; custody retained.");
  }
  assertCustodyScope(custodyScope);
  if (
    typeof value.Name !== "string" ||
    value.Name !== `/${dockerPersistentExecContainerName(receipt.attemptId)}` ||
    typeof value.State.Status !== "string" ||
    (identifier !== receipt.containerId && identifier !== value.Name.slice(1))
  ) {
    throw new Error("Docker stream container identity changed; custody retained.");
  }
  return {
    receipt,
    custodyScope,
    status: value.State.Status,
    // Docker retains StartedAt after exit, including commands that finish before inspection.
    hasStarted:
      typeof value.State.StartedAt === "string" &&
      value.State.StartedAt !== "0001-01-01T00:00:00Z" &&
      Number.isFinite(Date.parse(value.State.StartedAt)),
    exitCode:
      (value.State.Status === "exited" || value.State.Status === "dead") &&
      typeof value.State.ExitCode === "number" &&
      Number.isSafeInteger(value.State.ExitCode)
        ? value.State.ExitCode
        : null,
  };
}

function assertChildIdentity(
  child: ChildContainer,
  expected: DockerPersistentExecCleanupTarget,
): void {
  if (
    child.receipt.attemptId !== expected.attemptId ||
    child.receipt.parentContainerId !== expected.parentContainerId ||
    (expected.containerId !== undefined && child.receipt.containerId !== expected.containerId)
  ) {
    throw new Error("Docker stream container does not match its durable custody; cleanup refused.");
  }
}

/** A stopped container remains startable. Only confirmed removal fences every late START. */
export async function stopDockerPersistentExec(
  input: DockerPersistentExecCleanupTarget,
  assertCurrent: () => void = () => {},
): Promise<SandboxPersistentExecStopped> {
  const identity = captureCleanupTarget(input);
  return await runOutsideCommandProcessScope(async () => {
    assertCurrent();
    const signal = AbortSignal.timeout(CONTROL_TIMEOUT_MS);
    const engine = await assertDockerPersistentTargetCurrent(identity.target, signal);
    const identifier =
      identity.containerId ?? dockerPersistentExecContainerName(identity.attemptId);
    const child = await inspectChild(engine, identity.target, identifier, signal);
    assertCurrent();
    if (child) {
      assertChildIdentity(child, identity);
      // Docker owns namespace termination, including detached descendants and private volumes.
      await execContainer(engine, ["rm", "--force", "--volumes", child.receipt.containerId], {
        allowFailure: true,
        signal,
      });
      const after = await inspectChild(engine, identity.target, child.receipt.containerId, signal);
      assertCurrent();
      if (after) {
        throw new Error("Original Docker stream container still exists; custody retained.");
      }
    }
    await assertDockerPersistentTargetCurrent(identity.target, signal);
    assertCurrent();
    return {
      reason: child?.status === "exited" ? "source-exited" : "private stream container removed",
      exitCode: child?.exitCode ?? null,
      extinction: mintExtinctionProof(child?.receipt ?? identity),
    };
  });
}

/** Reconciliation candidates remain scoped to this physical store and its original daemon. */
export async function listDockerPersistentExecContainers(
  target: DockerPersistentExecTarget,
  custodyScope: string,
): Promise<DockerPersistentExecReceipt[]> {
  assertCustodyScope(custodyScope);
  const captured = parseDockerPersistentExecTarget(target);
  return await runOutsideCommandProcessScope(async () => {
    const signal = AbortSignal.timeout(CONTROL_TIMEOUT_MS);
    const engine = await assertDockerPersistentTargetCurrent(captured, signal);
    const listed = await execContainer(
      engine,
      [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${STORE_LABEL}=${custodyScope}`,
        "--format",
        "{{.ID}}",
      ],
      { signal },
    );
    const receipts: DockerPersistentExecReceipt[] = [];
    for (const id of listed.stdout.split(/\r?\n/u).filter(Boolean)) {
      if (!/^[a-f0-9]{64}$/u.test(id)) {
        throw new Error("Docker returned an invalid stream container identity; cleanup refused.");
      }
      const child = await inspectChild(engine, captured, id, signal);
      if (child?.custodyScope === custodyScope) {
        receipts.push(child.receipt);
      }
    }
    return receipts;
  });
}

export function createDockerPersistentExecCapability(params: {
  target: DockerPersistentExecTarget;
  containerId: string;
  containerStartedAt: string;
  containerName: string;
  workdir: string;
  configHash: string;
  imageReference: string;
  resolveImage: () => Promise<string>;
  assertCurrent: () => void;
  allocate: (input: {
    name: string;
    command: SandboxPersistentExecCommand;
    labels: Record<string, string>;
    assertCurrent: () => void;
  }) => Promise<string>;
}): SandboxPersistentExecCapability {
  const target = parseDockerPersistentExecTarget(params.target);
  return {
    target,
    containerId: params.containerId,
    containerName: params.containerName,
    containerStartedAt: params.containerStartedAt,
    workdir: params.workdir,
    configHash: params.configHash,
    imageReference: params.imageReference,
    resolveImage: params.resolveImage,
    async prepare(preparation) {
      return await runOutsideCommandProcessScope(async () => {
        assertCustodyScope(preparation.custodyScope);
        const identity = captureCleanupTarget({
          target,
          attemptId: preparation.attemptId,
          parentContainerId: params.containerId,
        });
        const assertCurrent = () => {
          preparation.signal.throwIfAborted();
          params.assertCurrent();
          preparation.assertCurrent();
        };
        const assertParentCurrent = async (signal = AbortSignal.timeout(CONTROL_TIMEOUT_MS)) => {
          assertCurrent();
          const currentSignal = AbortSignal.any([signal, preparation.signal]);
          const engine = await assertDockerPersistentTargetCurrent(target, currentSignal);
          const parent = await readDockerPersistentContainer(
            engine,
            params.containerId,
            currentSignal,
          );
          assertCurrent();
          if (parent.kind !== "running" || parent.startedAt !== params.containerStartedAt) {
            throw new Error("The admitted sandbox container generation has ended.");
          }
          return engine;
        };
        await assertParentCurrent();
        const command = preparation.command;
        if (command.argv.length === 0 || command.argv.some((arg) => arg.includes("\0"))) {
          throw new Error("Persistent sandbox execution requires a valid command argv.");
        }
        const containerId = await params.allocate({
          name: dockerPersistentExecContainerName(identity.attemptId),
          command,
          labels: {
            [ATTEMPT_LABEL]: identity.attemptId,
            [PARENT_LABEL]: identity.parentContainerId,
            [STORE_LABEL]: preparation.custodyScope,
          },
          assertCurrent,
        });
        const receipt = parseDockerPersistentExecReceipt({ ...identity, version: 1, containerId });
        const engine = await assertParentCurrent();
        const child = await inspectChild(
          engine,
          target,
          containerId,
          AbortSignal.any([preparation.signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)]),
        );
        assertCurrent();
        if (
          !child ||
          child.status !== "created" ||
          child.custodyScope !== preparation.custodyScope
        ) {
          throw new Error("Persistent sandbox preparation did not remain inert; custody retained.");
        }
        assertChildIdentity(child, receipt);

        const terminal = createDeferredCore<SandboxPersistentExecStopped>();
        void terminal.promise.catch(() => {});
        let phase: "prepared" | "starting" | "running" | "stopping" | "stopped" = "prepared";
        let transport:
          | Pick<ReturnType<typeof spawnCommand>, "kill" | "nodeChildProcess">
          | undefined;
        let transportSettled: Promise<void> = Promise.resolve();
        let launchSettled: Promise<void> = Promise.resolve();
        const consumers: Promise<void>[] = [];
        const pendingOutput = new Set<Promise<void>>();
        let stopFlight: Promise<SandboxPersistentExecStopped> | undefined;
        let confirmed: SandboxPersistentExecStopped | undefined;
        let failureMessage: string | undefined;
        let transportEnded = false;
        let explicitStop = false;
        let startupController: AbortController | undefined;
        const recordFailure = (error: unknown) => {
          failureMessage ??= (error instanceof Error ? error.message : String(error)).slice(
            0,
            2048,
          );
        };
        const stop = (): Promise<SandboxPersistentExecStopped> => {
          if (!transportEnded || explicitStop || failureMessage) {
            startupController?.abort(
              new Error(failureMessage ?? "Persistent sandbox execution was stopped during START."),
            );
          }
          if (confirmed) {
            return Promise.resolve(confirmed);
          }
          if (stopFlight) {
            return stopFlight;
          }
          phase = "stopping";
          stopFlight = runOutsideCommandProcessScope(async () => {
            await launchSettled;
            const extinct = await stopDockerPersistentExec(receipt);
            if (transportEnded && !explicitStop && extinct.reason !== "source-exited") {
              recordFailure(new Error("stream transport ended before the command exited"));
            }
            if (failureMessage) {
              transport?.kill("SIGKILL");
            }
            try {
              await withTimeout(
                Promise.all([transportSettled, ...consumers]),
                CONTROL_TIMEOUT_MS,
                "persistent sandbox output drain",
              );
            } catch (error) {
              recordFailure(error);
              transport?.kill("SIGKILL");
              transport?.nodeChildProcess.stdout?.destroy();
              transport?.nodeChildProcess.stderr?.destroy();
              throw error;
            }
            // A consumer timeout cannot cancel its pending write. Actual settlement is
            // required even after Docker has proved every guest process extinct.
            await withTimeout(
              Promise.allSettled(pendingOutput),
              CONTROL_TIMEOUT_MS,
              "persistent sandbox pending output settlement",
            );
            confirmed = failureMessage
              ? { ...extinct, reason: `stream transport/output failed: ${failureMessage}` }
              : extinct;
            phase = "stopped";
            terminal.resolve(confirmed);
            return confirmed;
          })
            .catch((error: unknown) => {
              transport?.kill("SIGKILL");
              terminal.reject(error);
              throw error;
            })
            .finally(() => {
              stopFlight = undefined;
            });
          return stopFlight;
        };
        const consume = async (stream: "stdout" | "stderr", output: Readable) => {
          try {
            // One awaited consumer per pipe preserves bounded Node/Docker backpressure.
            for await (const raw of output) {
              const chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
              if (chunk.byteLength > MAX_OUTPUT_CHUNK_BYTES) {
                throw new Error("Persistent sandbox output exceeded its bounded chunk size.");
              }
              const consumed = Promise.resolve(preparation.onOutput(stream, chunk));
              pendingOutput.add(consumed);
              void consumed.then(
                () => pendingOutput.delete(consumed),
                () => pendingOutput.delete(consumed),
              );
              await withTimeout(consumed, CONTROL_TIMEOUT_MS, "persistent sandbox output consumer");
            }
          } catch (error) {
            recordFailure(error);
            void stop().catch(() => {});
          }
        };
        return {
          receipt,
          async checkCurrent() {
            await assertParentCurrent();
          },
          stopped: terminal.promise,
          async start(admit) {
            if (phase !== "prepared") {
              throw new Error(
                "Persistent sandbox START is only valid for its admitted prepared owner.",
              );
            }
            phase = "starting";
            const launch = (async () => {
              const currentEngine = await assertParentCurrent();
              const current = await inspectChild(
                currentEngine,
                target,
                containerId,
                AbortSignal.any([preparation.signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)]),
              );
              assertCurrent();
              if (phase !== "starting" || !current || current.status !== "created") {
                throw new Error("The prepared sandbox stream is no longer available for START.");
              }
              assertChildIdentity(current, receipt);
              await admit();
              // Admission can await durable state while the physical parent ends or restarts.
              const startEngine = await assertParentCurrent();
              if (phase !== "starting") {
                throw new Error("Persistent sandbox execution was stopped during START admission.");
              }
              // Docker attaches both output pipes before START; no guest response grants
              // authority or proves cleanup. This local process outlives the creating turn.
              // Keep the final authority check and native launch together, without broker queueing.
              const started = runOutsideCommandProcessScope(() =>
                runWithSpawnBroker(undefined, () => {
                  assertCurrent();
                  return spawnCommand(
                    [
                      startEngine.command,
                      ...(startEngine.globalArgs ?? []),
                      "start",
                      "--attach",
                      containerId,
                    ],
                    {
                      baseEnv: startEngine.baseEnv,
                      buffer: false,
                      cancelSignal: preparation.signal,
                      reject: false,
                      stdio: ["ignore", "pipe", "pipe"],
                    },
                  );
                }),
              );
              transport = started;
              transportSettled = Promise.resolve(started).then(
                (result) => {
                  transportEnded = true;
                  if (result.failed && !isPlainCommandExitFailure(result)) {
                    recordFailure(new Error("persistent sandbox Docker transport failed"));
                  }
                  void stop().catch(() => {});
                },
                (error: unknown) => {
                  transportEnded = true;
                  recordFailure(error);
                  void stop().catch(() => {});
                },
              );
              await withTimeout(
                waitForCommandSpawn(started),
                CONTROL_TIMEOUT_MS,
                "persistent sandbox transport admission",
              );
              const output = started.nodeChildProcess.stdout;
              const errors = started.nodeChildProcess.stderr;
              if (!output || !errors) {
                throw new Error("Persistent sandbox transport did not provide its output pipes.");
              }
              consumers.push(consume("stdout", output), consume("stderr", errors));
              startupController = new AbortController();
              const signal = AbortSignal.any([startupController.signal, preparation.signal]);
              const deadline = setTimeout(
                () =>
                  startupController?.abort(
                    new Error(
                      `Persistent sandbox command did not start within ${CONTROL_TIMEOUT_MS}ms.`,
                    ),
                  ),
                CONTROL_TIMEOUT_MS,
              );
              try {
                // Spawning `docker start --attach` only starts the local transport. Keep
                // START pending until the original daemon records actual guest execution.
                for (;;) {
                  signal.throwIfAborted();
                  assertCurrent();
                  if (explicitStop || failureMessage) {
                    throw new Error(
                      failureMessage ?? "Persistent sandbox execution was stopped during START.",
                    );
                  }
                  const observed = await inspectChild(startEngine, target, containerId, signal);
                  signal.throwIfAborted();
                  assertCurrent();
                  if (!observed || observed.custodyScope !== preparation.custodyScope) {
                    throw new Error(
                      "Persistent sandbox START lost its original container custody.",
                    );
                  }
                  assertChildIdentity(observed, receipt);
                  if (observed.hasStarted) {
                    await assertParentCurrent(signal);
                    signal.throwIfAborted();
                    break;
                  }
                  if (transportEnded) {
                    throw new Error(
                      "Persistent sandbox transport ended before the command started.",
                    );
                  }
                  await sleep(START_POLL_INTERVAL_MS, signal);
                }
              } catch (error) {
                signal.throwIfAborted();
                throw error;
              } finally {
                clearTimeout(deadline);
                startupController = undefined;
              }
              if (phase === "starting") {
                phase = "running";
              }
            })();
            launchSettled = launch.then(
              () => {},
              () => {},
            );
            try {
              await launch;
            } catch (error) {
              recordFailure(error);
              try {
                await stop();
              } catch (cleanupError) {
                throw new AggregateError(
                  [error, cleanupError],
                  "Sandbox START failed and container cleanup remains unresolved.",
                  { cause: cleanupError },
                );
              }
              throw error;
            }
          },
          stop() {
            explicitStop = true;
            return stop();
          },
        };
      });
    },
  };
}
