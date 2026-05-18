export function shouldUseDetachedVitestProcessGroup(platform = process.platform) {
  return platform !== "win32";
}

export function resolveVitestProcessGroupSignalTarget(params) {
  const pid = params.childPid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return shouldUseDetachedVitestProcessGroup(params.platform) ? -pid : pid;
}

export function forwardSignalToVitestProcessGroup(params) {
  const target = resolveVitestProcessGroupSignalTarget({
    childPid: params.child.pid,
    platform: params.platform,
  });
  if (target === null) {
    return false;
  }
  try {
    params.kill(target, params.signal);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ESRCH" || error.code === "EPERM")
    ) {
      return false;
    }
    throw error;
  }
}

function isIgnorableProcessLookupError(error) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ESRCH" || error.code === "EPERM")
  );
}

export function isVitestProcessGroupAlive(params) {
  const target = resolveVitestProcessGroupSignalTarget({
    childPid: params.childPid,
    platform: params.platform,
  });
  if (target === null) {
    return false;
  }
  const kill = params.kill ?? process.kill.bind(process);
  try {
    kill(target, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

export async function waitForVitestProcessGroupExit(params) {
  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs ?? 5_000));
  const intervalMs = Math.max(10, Math.floor(params.intervalMs ?? 100));
  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const startedAt = Date.now();
  while (
    isVitestProcessGroupAlive({
      childPid: params.childPid,
      platform: params.platform,
      kill: params.kill,
    })
  ) {
    if (Date.now() - startedAt >= timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeoutFn(resolve, intervalMs));
  }
  return true;
}

export async function cleanupVitestProcessGroupAfterExit(params) {
  const childPid = params.childPid ?? params.child?.pid;
  const platform = params.platform ?? process.platform;
  const kill = params.kill ?? process.kill.bind(process);
  const graceMs = Math.max(0, Math.floor(params.graceMs ?? 5_000));
  const forceGraceMs = Math.max(0, Math.floor(params.forceGraceMs ?? 2_000));
  const log = params.log ?? (() => {});
  if (typeof childPid !== "number" || !Number.isInteger(childPid) || childPid <= 0) {
    return {
      staleProcessDetected: false,
      clean: true,
      signalsSent: [],
    };
  }

  if (!isVitestProcessGroupAlive({ childPid, platform, kill })) {
    return {
      staleProcessDetected: false,
      clean: true,
      signalsSent: [],
    };
  }

  const signalsSent = [];
  log(
    `[vitest] stale process group detected after gate exit (pid=${childPid}); cleaning up scoped group.`,
  );
  try {
    if (
      forwardSignalToVitestProcessGroup({
        child: { pid: childPid },
        signal: "SIGTERM",
        platform,
        kill,
      })
    ) {
      signalsSent.push("SIGTERM");
    }
  } catch (error) {
    if (!isIgnorableProcessLookupError(error)) {
      throw error;
    }
  }

  const cleanAfterTerm = await waitForVitestProcessGroupExit({
    childPid,
    platform,
    kill,
    timeoutMs: graceMs,
    intervalMs: params.intervalMs,
    setTimeoutFn: params.setTimeoutFn,
  });
  if (cleanAfterTerm) {
    return {
      staleProcessDetected: true,
      clean: true,
      signalsSent,
    };
  }

  try {
    if (
      forwardSignalToVitestProcessGroup({
        child: { pid: childPid },
        signal: "SIGKILL",
        platform,
        kill,
      })
    ) {
      signalsSent.push("SIGKILL");
    }
  } catch (error) {
    if (!isIgnorableProcessLookupError(error)) {
      throw error;
    }
  }

  const cleanAfterKill = await waitForVitestProcessGroupExit({
    childPid,
    platform,
    kill,
    timeoutMs: forceGraceMs,
    intervalMs: params.intervalMs,
    setTimeoutFn: params.setTimeoutFn,
  });
  return {
    staleProcessDetected: true,
    clean: cleanAfterKill,
    signalsSent,
  };
}

function ensureProcessListenerCapacity(processObject, eventName, additionalListeners = 1) {
  if (
    typeof processObject.getMaxListeners !== "function" ||
    typeof processObject.setMaxListeners !== "function" ||
    typeof processObject.listenerCount !== "function"
  ) {
    return;
  }

  const currentLimit = processObject.getMaxListeners();
  if (currentLimit === 0) {
    return;
  }

  const neededLimit = processObject.listenerCount(eventName) + additionalListeners + 1;
  if (neededLimit > currentLimit) {
    processObject.setMaxListeners(neededLimit);
  }
}

export function installVitestProcessGroupCleanup(params) {
  const processObject = params.processObject ?? process;
  const platform = params.platform ?? process.platform;
  const kill = params.kill ?? process.kill.bind(process);
  const cleanupSignal = params.cleanupSignal ?? "SIGTERM";
  const forwardedSignals = params.forwardedSignals ?? ["SIGINT", "SIGTERM"];
  const child = params.child;

  let active = true;

  const forward = (signal) => {
    if (!active) {
      return;
    }
    forwardSignalToVitestProcessGroup({
      child,
      signal,
      platform,
      kill,
    });
  };

  const signalHandlers = new Map();
  for (const signal of forwardedSignals) {
    const handler = () => {
      forward(signal);
    };
    signalHandlers.set(signal, handler);
    ensureProcessListenerCapacity(processObject, signal);
    processObject.on(signal, handler);
  }

  const exitHandler = () => {
    forward(cleanupSignal);
  };
  ensureProcessListenerCapacity(processObject, "exit");
  processObject.on("exit", exitHandler);

  return () => {
    if (!active) {
      return;
    }
    active = false;
    for (const [signal, handler] of signalHandlers) {
      processObject.off(signal, handler);
    }
    processObject.off("exit", exitHandler);
  };
}
