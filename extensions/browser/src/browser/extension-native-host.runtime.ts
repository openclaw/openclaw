import { readBrowserHostConfig } from "./extension-host-config.js";
import { buildBrowserExtensionPairing } from "./extension-pairing.js";
import { ensureExtensionRelayDaemonProcess } from "./extension-relay-daemon-spawn.js";

export async function buildBrowserNativeHostPairing(profile?: string) {
  return buildBrowserExtensionPairing({
    cfg: await readBrowserHostConfig(),
    localTransport: "gateway",
    profile,
  });
}

export async function ensureBrowserNativeRelay(port: number, entryPath: string) {
  return ensureExtensionRelayDaemonProcess({ port, cfg: await readBrowserHostConfig(), entryPath });
}
