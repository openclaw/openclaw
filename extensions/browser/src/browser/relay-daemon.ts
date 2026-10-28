import fs from "node:fs";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { captureRuntimeConfigAsyncReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { extractErrorCode } from "openclaw/plugin-sdk/security-runtime";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { readExtensionRelayToken } from "./extension-relay/relay-auth.js";
import {
  type ExtensionRelayHandle,
  startExtensionRelayServer,
} from "./extension-relay/relay-server.js";

const log = createSubsystemLogger("browser").child("relay-daemon");

/** Default grace before a daemon with no extension and no CDP clients exits. */
const RELAY_DAEMON_IDLE_EXIT_MS = 10 * 60 * 1000;
const IDLE_POLL_MS = 30 * 1000;

type RelayDaemonExitReason = "port-in-use" | "no-credential" | "idle" | "superseded" | "stopped";

/**
 * On-disk identity of the file the daemon was launched from. An in-place app or
 * package update keeps the path but installs new files, so the path alone
 * cannot tell this installation from its replacement. Null when the file is
 * gone; undefined when it cannot be read, which is not proof of replacement.
 */
function readInstallationIdentity(file: string): string | null | undefined {
  try {
    const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
    return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` : null;
  } catch {
    return undefined;
  }
}

/**
 * Run the standalone extension relay daemon: one loopback relay server with no
 * Gateway. The daemon stays alive while the paired extension holds its relay
 * connection or a CDP client is attached, and exits once both sides have been
 * gone for the idle grace so an idle daemon never outlives Chrome. It also
 * exits, peers or not, once the installation it was launched from is replaced
 * or removed: the extension's reconnect then wakes the native host of the
 * current installation instead of adopting a relay from a retired one.
 * The caller awaits done and owns process.exit.
 * The returned port is null when startup was refused.
 */
export async function runExtensionRelayDaemon(params: {
  port: number;
  /**
   * Accept the legacy one-directional relay auth (Bearer/Basic/token
   * subprotocol). Defaults to false: the standalone daemon is v2-only, so a
   * process that squats the relay port cannot harvest the secret from a legacy
   * client, and an operator's `extensionRelay.allowLegacyAuth=false` is never
   * silently reverted. The extension and mcporter both speak v2.
   */
  allowLegacyAuth?: boolean;
  /** File whose replacement or removal retires this daemon (the daemon entry). */
  installationPath?: string;
}) {
  const allowLegacyAuth = params.allowLegacyAuth ?? false;
  const now = Date.now;
  // Snapshot before any await so an update racing startup still reads as a replacement.
  const installationPath = params.installationPath;
  const installation = installationPath ? readInstallationIdentity(installationPath) : null;
  if (installationPath && !installation) {
    log.warn(
      `relay daemon cannot read its installation at ${installationPath}; update detection is off`,
    );
  }
  const completion = createDeferred<RelayDaemonExitReason>();

  const token = readExtensionRelayToken();
  if (!token) {
    log.warn("relay daemon refused to start: no extension relay credential");
    completion.resolve("no-credential");
    return { done: completion.promise, port: null, stop: () => {} };
  }

  let handle: ExtensionRelayHandle;
  try {
    const config = await captureRuntimeConfigAsyncReader()();
    const resolved = resolveBrowserConfig(config.browser, config);
    const profiles = Object.keys(resolved.profiles).filter((name) => {
      const profile = resolveProfile(resolved, name);
      return profile?.driver === "extension" && profile.cdpPort === params.port;
    });
    // The listener owns this fact. Ambiguous/unconfigured ports never advertise owner access.
    const profileName = profiles.length === 1 ? profiles[0] : undefined;
    handle = await startExtensionRelayServer({
      port: params.port,
      token,
      allowLegacyAuth,
      profileName,
    });
  } catch (error) {
    if (extractErrorCode(error) === "EADDRINUSE") {
      log.info(`relay port ${params.port} is already served; standalone daemon not needed`);
      completion.resolve("port-in-use");
      return { done: completion.promise, port: null, stop: () => {} };
    }
    throw error;
  }
  log.info(`standalone extension relay listening on 127.0.0.1:${handle.port}`);

  let lastActiveAtMs = now();
  let stopped = false;
  const finish = (reason: RelayDaemonExitReason): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(idleTimer);
    void handle.close().then(() => completion.resolve(reason), completion.reject);
  };
  const idleTimer = setInterval(() => {
    if (installationPath && installation) {
      const current = readInstallationIdentity(installationPath);
      if (current !== undefined && current !== installation) {
        log.info("relay daemon installation was replaced or removed; exiting");
        finish("superseded");
        return;
      }
    }
    if (handle.bridge.extensionConnected || handle.bridge.cdpClientCount > 0) {
      lastActiveAtMs = now();
      return;
    }
    if (now() - lastActiveAtMs >= RELAY_DAEMON_IDLE_EXIT_MS) {
      log.info("relay daemon idle (no extension, no CDP clients); exiting");
      finish("idle");
    }
  }, IDLE_POLL_MS);
  idleTimer.unref?.();

  return {
    done: completion.promise,
    port: handle.port,
    stop: () => finish("stopped"),
  };
}
