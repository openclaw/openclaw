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
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
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
    processObject.on(signal, handler);
  }

  const exitHandler = () => {
    forward(cleanupSignal);
  };
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
