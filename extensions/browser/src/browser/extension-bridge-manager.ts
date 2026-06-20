// extension-bridge-manager.ts — node-side singleton lifecycle for the extension
// CDP bridge. Started when a browser profile uses driver "extension"; stopped
// with the browser control service.

import { DEFAULT_EXTENSION_BRIDGE_PORT } from "./config.js";
import {
  startExtensionBridgeServer,
  type ExtensionBridgeHandle,
} from "./extension-bridge-server.js";

let handle: ExtensionBridgeHandle | null = null;
let starting: Promise<ExtensionBridgeHandle> | null = null;

export async function ensureExtensionBridge(opts: {
  port?: number;
  authToken?: string;
  identity?: { nodeId?: string; nodeIntegrated?: boolean };
  onWarn?: (m: string) => void;
  onAgentRequest?: (payload: { message: string; sessionKey?: string }) => Promise<void>;
}): Promise<ExtensionBridgeHandle> {
  if (handle) return handle;
  if (starting) return starting;
  const port = opts.port ?? DEFAULT_EXTENSION_BRIDGE_PORT;
  starting = startExtensionBridgeServer({
    port,
    authToken: opts.authToken,
    identity: opts.identity,
    logger: { info: (m) => opts.onWarn?.(m), warn: (m) => opts.onWarn?.(m) },
    onAgentRequest: opts.onAgentRequest,
  })
    .then((h) => {
      handle = h;
      starting = null;
      return h;
    })
    .catch((e) => {
      starting = null;
      throw e;
    });
  return starting;
}

export async function stopExtensionBridge(): Promise<void> {
  const h = handle;
  handle = null;
  if (h) await h.stop().catch(() => {});
}

export function extensionBridgeRunning(): boolean {
  return !!handle;
}

export function extensionConnectedToBridge(): boolean {
  return !!handle && handle.extensionConnected();
}
