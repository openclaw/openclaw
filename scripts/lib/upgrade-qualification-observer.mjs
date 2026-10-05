/** External release tooling only; production runtime never imports these modules. */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Transport, connect, admitSession } from "./upgrade-qualification-inspector.mjs";
import {
  sha,
  delay,
  bytes,
  retain,
  processIdentity,
  inspectorEndpoint,
  verifyArtifacts,
  observedEntryPath,
  verifyObservedEntry,
  probe,
  protectedInventory,
  scan,
  alive,
  assertObservationAudit,
  assertCompilerMapping,
  assertNativeObservationSelectors,
} from "./upgrade-qualification-observation-files.mjs";

export async function runHistoricalObservation(binding, directory) {
  const nativeSelectors = assertNativeObservationSelectors(binding);
  await fs.mkdir(directory, { mode: 0o700 });
  for (const tooling of binding.observerFiles) {
    await bytes(tooling);
  }
  await verifyArtifacts(binding);
  for (const mapping of binding.mappings) {
    assertObservationAudit(JSON.parse(await bytes(mapping.semanticAudit)), mapping, binding);
    assertCompilerMapping(
      JSON.parse(await bytes(mapping.sourceMap)),
      mapping,
      await bytes(mapping.source),
    );
    for (const frame of Object.values(mapping.factFrames ?? {})) {
      if (frame) {
        assertCompilerMapping(
          JSON.parse(await bytes(frame.sourceMap)),
          frame,
          await bytes(frame.source),
        );
      }
    }
  }
  const protectedBefore = await protectedInventory(binding.protectedRoots);
  await retain(directory, "protected-before.json", protectedBefore);
  const baseline = new Map((await scan()).map((item) => [item.pid, item.startTime]));
  const sockets = new Set();
  const admissions = [];
  const liveTargetArtifacts = new Map();
  const onLiveTarget = (file) => liveTargetArtifacts.set(file.path, file);
  const verifyObservedArtifacts = async () => {
    await verifyArtifacts(binding);
    for (const file of liveTargetArtifacts.values()) {
      await bytes(file);
    }
  };
  const retained = [];
  let failure;
  let boundary;
  let capturedRun;
  let originalCustody;
  const captureRun = async (uuid, mapping, identity) => {
    if (capturedRun) {
      throw new Error("Original production UUID cannot be recaptured or replaced.");
    }
    const protectedAtCapture = await protectedInventory(binding.protectedRoots);
    if (!isDeepStrictEqual(protectedBefore, protectedAtCapture)) {
      throw new Error("Protected state mutated before original UUID capture.");
    }
    await retain(directory, "protected-at-capture.json", protectedAtCapture);
    capturedRun = uuid;
    await retain(directory, "original-run.json", {
      observationId: binding.runId,
      originalRunId: uuid,
      mappingId: mapping.id,
      captureStage: mapping.captureStage,
      identity,
      source: mapping.source,
      sourceMap: mapping.sourceMap,
      semanticAudit: mapping.semanticAudit,
      protectedBeforeSha256: sha(Buffer.from(JSON.stringify(protectedBefore))),
      protectedAtCaptureSha256: sha(Buffer.from(JSON.stringify(protectedAtCapture))),
      noProtectedMutationBeforeCapture: true,
    });
  };
  const refuse = (error) => {
    failure ??= error;
  };
  const run = async (argv, phase) => {
    await bytes(binding.nativeBootstrap);
    if (argv[0] !== binding.nativeBootstrap.path || !argv.includes("--qualification-inspector")) {
      throw new Error("Native startup admission is mandatory.");
    }
    const account = userInfo();
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: account.homedir,
        USER: account.username,
        LOGNAME: account.username,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = await fs.open(path.join(directory, `${phase}-native.log`), "wx", 0o600);
    let logWrites = Promise.resolve();
    const keepLog = (chunk) => {
      logWrites = logWrites.then(() => log.write(chunk)).catch(refuse);
    };
    child.stdout.on("data", keepLog);
    child.stderr.on("data", keepLog);
    let exit;
    child.once("error", refuse);
    const settled = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        exit = { code, signal };
        resolve(exit);
      });
    });
    const owned = new Map();
    const attached = new Set();
    const workerOccurrences = new Map();
    const deadline = Date.now() + binding.timeoutMs;
    let completed = false;
    let preserveStoppedOnRefusal = false;
    const onBoundary = async (event) => {
      if (!(await alive(event.identity))) {
        throw new Error("Original boundary process exited or was reused.");
      }
      const receipt = {
        observationId: binding.runId,
        runId: capturedRun,
        boundary: binding.boundary,
        side: binding.side,
        phase,
        mappingId: event.mapping.id,
        identity: event.identity,
        worker: event.worker,
        observedFacts: event.observedFacts,
        selectedFrames: event.selectedFrames,
        heldRuntime: event.heldRuntime,
        script: event.mapping.script,
        location: event.mapping.location,
        semanticAudit: event.mapping.semanticAudit,
        frames: event.pause.callFrames.map((frame) => ({
          functionName: frame.functionName,
          url: frame.url,
          location: frame.location,
        })),
      };
      if (event.retained) {
        await verifyObservedArtifacts();
        retained.push(receipt);
        return;
      }
      if (boundary) {
        throw new Error("Boundary was observed more than once.");
      }
      if (
        binding.boundary === "gate-release" &&
        (event.heldRuntime?.stage !== "debugger-held-before-kernel-stop" ||
          event.heldRuntime.maintenanceHeld !== (binding.side === "before") ||
          event.heldRuntime.suspensionPhase !== event.mapping.heldRuntime?.expected.suspensionPhase)
      ) {
        throw new Error("Gate release lacks its held-runtime observation before SIGSTOP.");
      }
      // Stop the known tree, then close discovery races before inspecting durable effects.
      // A descendant may have spawned between the last scan and the debugger hit.
      for (const identity of owned.values()) {
        if (await alive(identity)) {
          process.kill(identity.pid, "SIGSTOP");
        }
      }
      for (const identity of owned.values()) {
        if (await alive(identity)) {
          let actual = await processIdentity(identity.pid);
          const stopDeadline = Date.now() + 5000;
          while (!["T", "t"].includes(actual.state) && Date.now() < stopDeadline) {
            await delay(10);
            actual = await processIdentity(identity.pid);
          }
          if (actual.startTime !== identity.startTime || !["T", "t"].includes(actual.state)) {
            throw new Error("Owned process was not kernel-stopped.");
          }
        }
      }
      let added;
      do {
        added = false;
        for (const candidate of await scan()) {
          if (baseline.get(candidate.pid) === candidate.startTime || owned.has(candidate.pid)) {
            continue;
          }
          if (
            candidate.group !== child.pid &&
            !owned.has(candidate.parent) &&
            !candidate.cgroups.some((group) => binding.serviceCgroups.includes(group))
          ) {
            continue;
          }
          owned.set(candidate.pid, candidate);
          added = true;
          if (await alive(candidate)) {
            process.kill(candidate.pid, "SIGSTOP");
          }
        }
      } while (added);
      for (const identity of owned.values()) {
        if (await alive(identity)) {
          const current = await processIdentity(identity.pid);
          if (current.startTime !== identity.startTime || !["T", "t"].includes(current.state)) {
            throw new Error("Crash group contains an ungated running process.");
          }
        }
      }
      preserveStoppedOnRefusal = true;
      await verifyObservedArtifacts();
      const durable = await probe({
        ...binding,
        originalRunId: capturedRun,
        observedFacts: event.observedFacts,
      });
      receipt.ownerProvenance = durable.ownerProvenance;
      originalCustody = durable.custody;
      preserveStoppedOnRefusal = false;
      await retain(directory, "boundary.json", {
        ...receipt,
        durable,
        nativeSelectors,
        status: "observed-stopped-not-yet-killed",
        qualificationPassed: false,
      });
      boundary = receipt;
    };
    try {
      while (Date.now() < deadline) {
        if (failure) {
          throw failure;
        }
        const processes = await scan();
        const members = new Set([child.pid]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const identity of processes) {
            if (members.has(identity.parent) && !members.has(identity.pid)) {
              members.add(identity.pid);
              grew = true;
            }
          }
        }
        for (const identity of processes) {
          const belongs =
            members.has(identity.pid) ||
            identity.cgroups.some((cgroup) => binding.serviceCgroups.includes(cgroup));
          if (
            !belongs ||
            baseline.get(identity.pid) === identity.startTime ||
            ["Z", "X"].includes(identity.state)
          ) {
            continue;
          }
          owned.set(identity.pid, identity);
          if (identity.argv.includes("--inspect-brk=127.0.0.1:0") && !attached.has(identity.pid)) {
            if (
              identity.executable !== binding.runtime.path ||
              identity.argv[0] !== binding.runtime.path
            ) {
              throw new Error("Startup-held runtime differs from sealed executable.");
            }
            const entry = identity.argv[2];
            const mappings = binding.mappings.filter(
              (item) => item.phase === phase && observedEntryPath(item) === entry && !item.worker,
            );
            if (!mappings.length) {
              throw new Error(`Startup-held process has no reviewed ${phase} mapping: ${entry}`);
            }
            await bytes(binding.runtime);
            for (const mapping of mappings) {
              const live = await verifyObservedEntry(mapping, binding);
              if (live) {
                onLiveTarget(live);
              }
            }
            const connection = await connect(
              await inspectorEndpoint(identity.pid),
              Math.min(binding.timeoutMs, 10000),
            );
            sockets.add(connection.socket);
            attached.add(identity.pid);
            admissions.push({
              phase,
              identity,
              native: binding.nativeBootstrap,
              nativeArgv: argv,
              mappings: mappings.map((item) => item.id),
              startupGate: "native-inspect-brk",
            });
            const workers = new Map();
            connection.transport.handlers.push((message) => {
              if (message.method === "Runtime.executionContextsCleared") {
                connection.socket.close();
              }
              if (message.method === "NodeWorker.receivedMessageFromWorker") {
                workers.get(message.params.sessionId)?.receive(JSON.parse(message.params.message));
              }
            });
            const onWorker = (info) => {
              void (async () => {
                if (!info.waitingForDebugger || workers.has(info.sessionId)) {
                  throw new Error("Worker lacks unique startup-held custody.");
                }
                const occurrenceKey = `${identity.pid}:${info.workerInfo.url}`;
                const occurrence = (workerOccurrences.get(occurrenceKey) ?? 0) + 1;
                workerOccurrences.set(occurrenceKey, occurrence);
                const mapped = binding.mappings.filter(
                  (item) =>
                    item.phase === phase &&
                    observedEntryPath(item) === entry &&
                    item.worker?.url === info.workerInfo.url &&
                    item.worker.occurrence === occurrence,
                );
                if (!mapped.length) {
                  throw new Error("Unmapped worker remains startup-held.");
                }
                const transport = new Transport(
                  (message) =>
                    connection.transport.call("NodeWorker.sendMessageToWorker", {
                      sessionId: info.sessionId,
                      message: JSON.stringify(message),
                    }),
                  10000,
                );
                workers.set(info.sessionId, transport);
                admissions.push({
                  phase,
                  identity,
                  worker: info,
                  mappings: mapped.map((item) => item.id),
                  startupGate: "NodeWorker",
                });
                await admitSession({
                  transport,
                  mappings: mapped,
                  binding,
                  phase,
                  process: identity,
                  worker: info,
                  onWorker: undefined,
                  onBoundary,
                  onError: refuse,
                  onCaptureRun: captureRun,
                  originalRunId: () => capturedRun,
                  onLiveTarget,
                });
              })().catch(refuse);
            };
            await admitSession({
              transport: connection.transport,
              mappings,
              binding,
              phase,
              process: identity,
              worker: undefined,
              onBoundary,
              onError: refuse,
              onWorker,
              onCaptureRun: captureRun,
              originalRunId: () => capturedRun,
              onLiveTarget,
            });
          }
        }
        if (phase === "fresh" && boundary) {
          // Revalidate each PID immediately before physical kill, including reparented services.
          const killed = [];
          for (const identity of owned.values()) {
            if (await alive(identity)) {
              const actual = await processIdentity(identity.pid);
              if (actual.startTime !== identity.startTime || !["T", "t"].includes(actual.state)) {
                throw new Error("Kill target lost original stopped identity.");
              }
              process.kill(identity.pid, "SIGKILL");
              killed.push(identity);
            }
          }
          while ((await Promise.all(killed.map(alive))).some(Boolean)) {
            if (Date.now() >= deadline) {
              throw new Error("Killed owned group did not terminate.");
            }
            await delay(10);
          }
          await retain(directory, "termination.json", {
            observationId: binding.runId,
            runId: capturedRun,
            killed,
            terminated: true,
          });
          await settled;
          completed = true;
          return;
        }
        if (exit) {
          if (exit.code !== 0 || phase === "fresh" || !retained.length) {
            throw new Error(
              "Operation exited without its required actual boundary/retained proof.",
            );
          }
          completed = true;
          return;
        }
        await delay(20);
      }
      throw new Error("Unchanged-artifact observation timed out.");
    } finally {
      // Kill only identities created by this launch, never pre-existing machine services.
      if (!completed && preserveStoppedOnRefusal) {
        await retain(directory, "custody-refusal.json", {
          observationId: binding.runId,
          originalRunId: capturedRun,
          stoppedIdentities: [...owned.values()],
          status: "stopped-preserved-no-crash-admission",
          qualificationPassed: false,
        });
      } else if (!completed) {
        for (const identity of owned.values()) {
          if (await alive(identity)) {
            process.kill(identity.pid, "SIGKILL");
          }
        }
        if (!exit) {
          child.kill("SIGKILL");
        }
        await settled;
      }
      await logWrites;
      await log.sync();
      await log.close();
    }
  };
  try {
    await run(binding.apply, "fresh");
    for (const socket of sockets) {
      socket.close();
    }
    sockets.clear();
    failure = undefined;
    if (!capturedRun) {
      throw new Error("Resume lost the actual production-allocated original UUID.");
    }
    const resume = binding.resume.map((argument) =>
      argument.replaceAll("{{original-run-id}}", capturedRun),
    );
    const selector = resume.indexOf("--retained-run");
    if (selector < 0 || resume[selector + 1] !== capturedRun) {
      throw new Error("Resume must select the captured original UUID.");
    }
    await retain(directory, "resume-command.json", {
      observationId: binding.runId,
      originalRunId: capturedRun,
      argv: resume,
    });
    await run(resume, "retained");
    await verifyObservedArtifacts();
    const resumed = await probe({ ...binding, originalRunId: capturedRun }, false);
    if (!isDeepStrictEqual(originalCustody, resumed.custody)) {
      throw new Error("Native resume changed immutable original retained custody.");
    }
    await retain(directory, "observation.json", {
      schemaVersion: 1,
      purpose: binding.purpose,
      observationId: binding.runId,
      originalRunId: capturedRun,
      boundary: binding.boundary,
      side: binding.side,
      admissions,
      retained,
      nativeSelectors,
      originalCustody,
      boundaryObservation: boundary,
      resumedCustody: resumed.custody,
      immutableArtifacts: binding.artifacts,
      ...(binding.targetInstallation
        ? {
            targetInstallation: binding.targetInstallation,
            liveTargetArtifacts: [...liveTargetArtifacts.values()],
          }
        : {}),
      crashRecoveryObserved: true,
      qualificationPassed: false,
    });
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    throw new Error("Supply exact historical observation JSON and new receipt directory.");
  }
  await runHistoricalObservation(JSON.parse(await fs.readFile(input, "utf8")), output);
}
