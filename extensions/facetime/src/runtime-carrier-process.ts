import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { FaceTimeHelperPeer } from "./helper-rpc.js";

export async function terminateExactCarrierProcesses(params: {
  runtime: { system: Pick<PluginRuntime["system"], "runCommandWithTimeout"> };
  peers: ReadonlyMap<number, FaceTimeHelperPeer>;
  assertCurrent: () => void;
}): Promise<void> {
  params.assertCurrent();
  if (params.peers.size === 0) {
    throw new Error(
      "no authenticated carrier process identity is available for fail-closed shutdown",
    );
  }
  for (const peer of params.peers.values()) {
    const expected =
      peer.bundleIdentifier === "com.apple.FaceTime"
        ? "FaceTime"
        : peer.bundleIdentifier === "com.apple.FaceTime.FTConversationService"
          ? "FTConversationService"
          : peer.bundleIdentifier === "com.apple.mobilephone"
            ? "Phone"
            : peer.bundleIdentifier === "com.apple.TelephonyUtilities"
              ? "TelephonyUtilities"
              : "";
    const inspectExactProcess = async (): Promise<boolean> => {
      const inspected = await params.runtime.system.runCommandWithTimeout(
        ["/bin/ps", "-p", String(peer.processId), "-o", "comm="],
        { timeoutMs: 500 },
      );
      params.assertCurrent();
      if (inspected.code === 1 && !inspected.stdout.trim() && !inspected.stderr.trim()) {
        return false;
      }
      const executable = inspected.stdout.trim();
      if (
        inspected.code !== 0 ||
        !expected ||
        (executable !== expected && !executable.endsWith(`/${expected}`))
      ) {
        throw new Error("authenticated carrier process identity no longer matches its executable");
      }
      const started = await params.runtime.system.runCommandWithTimeout(
        ["/bin/ps", "-p", String(peer.processId), "-o", "lstart="],
        { timeoutMs: 500 },
      );
      params.assertCurrent();
      if (started.code === 1 && !started.stdout.trim() && !started.stderr.trim()) {
        return false;
      }
      const observedStartedAt = Date.parse(started.stdout.trim());
      if (
        started.code !== 0 ||
        !Number.isFinite(observedStartedAt) ||
        observedStartedAt !== Math.floor(peer.processStartedAtMs / 1_000) * 1_000
      ) {
        throw new Error("authenticated carrier process identity no longer matches its executable");
      }
      return true;
    };
    let alive = await inspectExactProcess();
    params.assertCurrent();
    for (const signal of ["-TERM", "-KILL"]) {
      if (!alive) {
        break;
      }
      await params.runtime.system.runCommandWithTimeout(
        ["/bin/kill", signal, String(peer.processId)],
        { timeoutMs: 500 },
      );
      params.assertCurrent();
      alive = await inspectExactProcess();
      params.assertCurrent();
    }
    if (alive) {
      throw new Error("authenticated carrier process remains alive after force termination");
    }
  }
}
