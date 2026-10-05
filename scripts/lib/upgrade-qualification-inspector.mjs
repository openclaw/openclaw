import { fileURLToPath, pathToFileURL } from "node:url";
import {
  sha,
  assertExactObservedLocation,
  observedScriptPath,
  verifyLiveTargetFile,
} from "./upgrade-qualification-observation-files.mjs";

export class Transport {
  constructor(send, timeoutMs) {
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.handlers = [];
    /** @type {Error | undefined} */
    this.failure = undefined;
  }
  call(method, params = {}) {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Inspector command timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      });
      Promise.resolve(this.send({ id, method, params })).catch(
        /** @param {unknown} error */ (error) => {
          const pending = this.pending.get(id);
          this.pending.delete(id);
          pending?.reject(error);
        },
      );
    });
  }
  receive(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (pending) {
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
      }
    } else {
      for (const handler of this.handlers) {
        handler(message);
      }
    }
  }
  fail(error) {
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
export async function connect(url, timeoutMs) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Inspector connection timed out.")), timeoutMs);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Inspector connection failed."));
      },
      { once: true },
    );
  });
  const transport = new Transport((message) => socket.send(JSON.stringify(message)), timeoutMs);
  socket.addEventListener("message", (event) => transport.receive(JSON.parse(event.data)));
  socket.addEventListener("close", () => transport.fail(new Error("Inspector closed.")));
  return { transport, socket };
}
/** Observe only held synchronous frames; never evaluate an async trace or fall back by name. */
export async function observePausedBoundary({
  transport,
  pause,
  scripts,
  mapping,
  binding,
  original,
  onLiveTarget,
}) {
  const top = pause.callFrames[0];
  assertExactObservedLocation(mapping.location, top?.location);
  const selectedFrames = {};
  const read = async (name, expression) => {
    let frame = top;
    const selector = mapping.factFrames?.[name];
    if (selector) {
      const filename = selector.liveScript ?? selector.script.path;
      const matches = pause.callFrames.filter((candidate) => {
        const url = scripts.get(candidate.location.scriptId)?.url;
        return (
          (url === filename || url === pathToFileURL(filename).href) &&
          candidate.functionName === selector.functionName &&
          candidate.location.lineNumber === selector.location.lineNumber &&
          candidate.location.columnNumber === selector.location.columnNumber
        );
      });
      if (matches.length !== 1) {
        throw new Error(`Exact synchronous ${name} frame is missing or ambiguous.`);
      }
      frame = matches[0];
      const source = await transport.call("Debugger.getScriptSource", {
        scriptId: frame.location.scriptId,
      });
      if (
        Buffer.byteLength(source.scriptSource) !== selector.script.length ||
        sha(Buffer.from(source.scriptSource)) !== selector.script.sha256
      ) {
        throw new Error("Observed ancestor frame differs from its immutable script.");
      }
      if (selector.liveScript) {
        const live = await verifyLiveTargetFile(binding, selector.liveScript, selector.script);
        onLiveTarget?.(live);
      }
    }
    if (!frame || !expression) {
      throw new Error(`Missing exact ${name} discriminator.`);
    }
    const result = await transport.call("Debugger.evaluateOnCallFrame", {
      callFrameId: frame.callFrameId,
      expression,
      returnByValue: true,
      throwOnSideEffect: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`Read-only ${name} observation refused; execution remains held.`);
    }
    selectedFrames[name] = { functionName: frame.functionName, location: frame.location };
    return result.result?.value;
  };
  if ((await read("guard", mapping.guardExpression)) !== true) {
    throw new Error("Original-run/action/database guard rejected; execution remains held.");
  }
  const ownerFacts = mapping.facts.kind;
  const expectedFacts = ownerFacts
    ? {}
    : {
        runId: original,
        actionId: mapping.actionId,
        operation: mapping.operation,
        ...(mapping.jobId
          ? { jobId: mapping.jobId.replaceAll("{{original-run-id}}", original) }
          : {}),
        ...(mapping.database ? { database: mapping.database } : {}),
      };
  const observedFacts = ownerFacts
    ? { kind: ownerFacts, payload: await read("ownerPayload", mapping.facts.payloadExpression) }
    : {};
  if (ownerFacts && (!observedFacts.payload || typeof observedFacts.payload !== "object")) {
    throw new Error("Missing read-only owner payload; execution remains held.");
  }
  for (const [name, expected] of Object.entries(expectedFacts)) {
    const value = await read(name, mapping.facts[name]);
    if (value !== expected) {
      throw new Error(`Original ${name} discriminator rejected; execution remains held.`);
    }
    observedFacts[name] = value;
  }
  // The runtime remains debugger-held until onBoundary has kernel-stopped its tree.
  // This is logical maintenance release, NOT a claim that independent suspension is open.
  let heldRuntime;
  if (mapping.heldRuntime) {
    const maintenanceHeld = await read(
      "maintenanceHeld",
      mapping.heldRuntime.maintenanceHeldExpression,
    );
    const suspensionPhase = await read(
      "suspensionPhase",
      mapping.heldRuntime.suspensionPhaseExpression,
    );
    const expected = mapping.heldRuntime.expected;
    if (
      maintenanceHeld !== expected.maintenanceHeld ||
      suspensionPhase !== expected.suspensionPhase
    ) {
      throw new Error("Held-runtime admission state disagrees with the reviewed boundary side.");
    }
    heldRuntime = { maintenanceHeld, suspensionPhase, stage: "debugger-held-before-kernel-stop" };
  }
  return { observedFacts, selectedFrames, heldRuntime };
}

/** Break before imported script execution; never rely on already-loaded ESM at startup. */
export async function admitSession({
  transport,
  mappings,
  binding,
  phase,
  process: identity,
  worker,
  onBoundary,
  onError,
  onWorker,
  onCaptureRun,
  originalRunId,
  onLiveTarget,
}) {
  let startup = false;
  let scriptGate;
  let startupResolve;
  const startupHeld = new Promise((resolve) => {
    startupResolve = resolve;
  });
  const scripts = new Map();
  const breaks = new Map();
  let queue = Promise.resolve();
  const armScript = async (scriptId, metadata) => {
    const scriptMappings = mappings.filter(
      (item) =>
        observedScriptPath(item) === metadata?.url ||
        pathToFileURL(observedScriptPath(item)).href === metadata?.url,
    );
    const source = await transport.call("Debugger.getScriptSource", { scriptId });
    // Every file script under fixture custody must match a sealed closure member.
    if (
      metadata?.url?.startsWith("file:///qualification/") ||
      metadata?.url?.startsWith("/qualification/")
    ) {
      const filename = metadata.url.startsWith("file:")
        ? fileURLToPath(metadata.url)
        : metadata.url;
      const target = Boolean(
        binding.targetInstallation && filename.startsWith(`${binding.installation}/`),
      );
      const artifact = target
        ? await verifyLiveTargetFile(binding, filename)
        : binding.artifacts.find((item) => item.path === filename);
      if (
        !artifact ||
        Buffer.byteLength(source.scriptSource) !== artifact.length ||
        sha(Buffer.from(source.scriptSource)) !== artifact.sha256
      ) {
        throw new Error("Loaded script differs from the authenticated closure.");
      }
      if (target) {
        onLiveTarget?.(artifact);
      }
    }
    for (const mapping of scriptMappings) {
      if (
        Buffer.byteLength(source.scriptSource) !== mapping.script.length ||
        sha(Buffer.from(source.scriptSource)) !== mapping.script.sha256
      ) {
        throw new Error("Boundary script digest mismatch.");
      }
      if (!mapping.location) {
        continue;
      } // Explicit audited startup-only mapping.
      const breakpoint = await transport.call("Debugger.setBreakpoint", {
        location: { scriptId, ...mapping.location },
      });
      assertExactObservedLocation(mapping.location, breakpoint.actualLocation);
      breaks.set(breakpoint.breakpointId, mapping);
    }
  };
  transport.handlers.push((message) => {
    if (message.method === "Debugger.scriptParsed") {
      scripts.set(message.params.scriptId, message.params);
    }
    if (message.method === "NodeWorker.attachedToWorker") {
      onWorker?.(message.params);
    }
    if (message.method === "Debugger.paused") {
      queue = queue
        .then(async () => {
          const pause = message.params;
          if (!startup) {
            if (pause.reason !== "Break on start") {
              throw new Error("Process was not held at native startup.");
            }
            startup = true;
            const remote = await transport.call("Runtime.evaluate", {
              expression: "process.pid",
              returnByValue: true,
              throwOnSideEffect: true,
            });
            if (remote.exceptionDetails || remote.result?.value !== identity.pid) {
              throw new Error("Inspector process identity mismatch.");
            }
            scriptGate = await transport.call("Debugger.setInstrumentationBreakpoint", {
              instrumentation: "beforeScriptExecution",
            });
            for (const [scriptId, metadata] of scripts) {
              if (
                metadata.url?.startsWith("file:///qualification/") ||
                metadata.url?.startsWith("/qualification/")
              ) {
                await armScript(scriptId, metadata);
              }
            }
            startupResolve();
            await transport.call("Debugger.resume");
            return;
          }
          if (
            pause.reason === "instrumentation" &&
            (pause.hitBreakpoints?.includes(scriptGate.breakpointId) ||
              (!pause.hitBreakpoints?.length && pause.data?.scriptId))
          ) {
            const scriptId = pause.data?.scriptId ?? pause.callFrames[0]?.location.scriptId;
            const metadata = scripts.get(scriptId);
            await armScript(scriptId, metadata);
            await transport.call("Debugger.resume");
            return;
          }
          const hits = (pause.hitBreakpoints ?? []).flatMap((id) =>
            breaks.has(id) ? [breaks.get(id)] : [],
          );
          if (hits.length !== 1) {
            throw new Error("Unexpected debugger pause; execution remains held.");
          }
          const mapping = hits[0];
          if (mapping.id === binding.runCaptureMappingId && phase === "fresh") {
            const observed = await transport.call("Debugger.evaluateOnCallFrame", {
              callFrameId: pause.callFrames[0].callFrameId,
              expression: mapping.captureRunExpression,
              returnByValue: true,
              throwOnSideEffect: true,
            });
            if (
              observed.exceptionDetails ||
              typeof observed.result?.value !== "string" ||
              !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
                observed.result.value,
              )
            ) {
              throw new Error("Production allocator did not supply an original UUID.");
            }
            assertExactObservedLocation(mapping.location, pause.callFrames[0].location);
            await onCaptureRun(observed.result.value, mapping, identity);
            await transport.call("Debugger.resume");
            return;
          }
          const original = originalRunId();
          if (!original) {
            throw new Error("Boundary reached before original production UUID custody.");
          }

          const observation = await observePausedBoundary({
            transport,
            pause,
            scripts,
            mapping,
            binding,
            original,
            onLiveTarget,
          });

          assertExactObservedLocation(mapping.location, pause.callFrames[0].location);
          if (phase === "fresh" && mapping.id === binding.selectedMappingId) {
            await onBoundary({ identity, worker, mapping, pause, ...observation });
          } else if (phase === "retained") {
            await onBoundary({ identity, worker, mapping, pause, ...observation, retained: true });
            await transport.call("Debugger.resume");
          } else {
            throw new Error("Nonselected boundary reached unexpectedly; execution remains held.");
          }
        })
        .catch(onError);
    }
  });
  await transport.call("Runtime.enable");
  await transport.call("Debugger.enable");
  if (onWorker) {
    await transport.call("NodeWorker.enable", { waitForDebuggerOnStart: true });
  }
  await transport.call("Runtime.runIfWaitingForDebugger");
  let startupTimer;
  try {
    await Promise.race([
      startupHeld,
      new Promise((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error("Native startup pause was not observed.")),
          Math.min(binding.timeoutMs, 10000),
        );
      }),
    ]);
  } finally {
    clearTimeout(startupTimer);
  }
}
