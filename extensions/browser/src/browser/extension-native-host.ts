import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasExactKeys } from "../../chrome-extension/modules/strict-json.js";
import { readPrivateNativeHostFile } from "./extension-native-host-file.js";
import {
  BROWSER_NATIVE_HOST_NAME,
  NATIVE_HOST_MANIFEST_KEYS,
} from "./extension-native-host.constants.js";
import {
  type BrowserNativeBootstrapResponse,
  type BrowserNativeRelayEnsureStatus,
  decodeBrowserNativeFrame,
  readBrowserNativeFrame,
} from "./extension-native-protocol.js";
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}\/$/;

function validateExpectedOrigins(origins: string[]): string[] {
  const canonical = [...new Set(origins)].toSorted();
  if (
    origins.length === 0 ||
    origins.length !== canonical.length ||
    origins.some((origin, index) => origin !== canonical[index]) ||
    origins.some((origin) => !EXTENSION_ORIGIN_PATTERN.test(origin))
  ) {
    throw new Error("invalid expected origins");
  }
  return canonical;
}

export function parseBrowserNativeHostOrigins(argv: string[]): {
  expectedOrigins: string[];
  callerOrigin: string;
} {
  const expectedOrigins: string[] = [];
  let callerOrigin = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--expected-origin") {
      const value = argv[index + 1];
      if (!value || callerOrigin) {
        throw new Error("invalid expected-origin arguments");
      }
      expectedOrigins.push(value);
      index += 1;
    } else if (argument?.startsWith("chrome-extension://")) {
      if (callerOrigin) {
        throw new Error("multiple Chrome extension origins");
      }
      callerOrigin = argument;
    }
  }
  validateExpectedOrigins(expectedOrigins);
  if (!EXTENSION_ORIGIN_PATTERN.test(callerOrigin)) {
    throw new Error("missing Chrome extension origin");
  }
  return { expectedOrigins, callerOrigin };
}

async function validateNativeManifest(
  params: Parameters<typeof runBrowserNativeHost>[0],
): Promise<void> {
  const manifestFile = await readPrivateNativeHostFile(params.manifestPath, false);
  const { realPath: launcherPath } = await readPrivateNativeHostFile(params.launcherPath, true);
  const managedRoot = path.resolve(
    params.stateDir ?? resolveStateDir(),
    "browser",
    "native-messaging",
  );
  if (!isPathInside(managedRoot, launcherPath)) {
    throw new Error("launcher is outside the managed root");
  }
  const parsed: unknown = JSON.parse(manifestFile.buffer.toString("utf8"));
  const manifest = asNullableRecord(parsed);
  if (!manifest) {
    throw new Error("invalid manifest");
  }
  const expectedOrigins = validateExpectedOrigins(params.expectedOrigins);
  if (
    !hasExactKeys(manifest, NATIVE_HOST_MANIFEST_KEYS) ||
    manifest.name !== BROWSER_NATIVE_HOST_NAME ||
    manifest.type !== "stdio" ||
    (process.platform === "win32"
      ? typeof manifest.path !== "string" ||
        manifest.path.toLowerCase() !== launcherPath.toLowerCase()
      : manifest.path !== launcherPath) ||
    !Array.isArray(manifest.allowed_origins) ||
    JSON.stringify(manifest.allowed_origins) !== JSON.stringify(expectedOrigins)
  ) {
    throw new Error("invalid manifest");
  }
  if (!expectedOrigins.includes(params.callerOrigin)) {
    throw new Error("origin forbidden");
  }
}

export async function runBrowserNativeHost(params: {
  manifestPath: string;
  launcherPath: string;
  callerOrigin: string;
  expectedOrigins: string[];
  input: AsyncIterable<Buffer>;
  buildPairing: (boundProfile?: string) => Promise<{ pairingString: string; topology: string }>;
  /** Ensure the standalone extension relay daemon is running (ensure_relay op). */
  ensureRelay: (port: number) => Promise<BrowserNativeRelayEnsureStatus>;
  stateDir?: string;
}): Promise<BrowserNativeBootstrapResponse> {
  let response: BrowserNativeBootstrapResponse;
  try {
    const decoded = decodeBrowserNativeFrame(await readBrowserNativeFrame(params.input));
    if (!decoded.ok) {
      response = { v: 1, ok: false, code: decoded.code };
    } else {
      let boundProfile: string | undefined;
      try {
        if (process.platform === "win32") {
          const { validateWindowsNativeContext } = await import("./extension-windows-host.js");
          boundProfile = await validateWindowsNativeContext(params);
          // Windows was admitted against its fixed Known Folder generation, not the POSIX state root.
          if (!params.expectedOrigins.includes(params.callerOrigin)) {
            throw new Error("origin forbidden");
          }
        } else {
          await validateNativeManifest(params);
        }
      } catch (error) {
        response = {
          v: 1,
          ok: false,
          code:
            error instanceof Error && error.message === "origin forbidden"
              ? "origin_forbidden"
              : "manifest_invalid",
        };
        return response;
      }
      try {
        if (decoded.request.op === "ensure_relay") {
          const relay = await params.ensureRelay(decoded.request.relayPort);
          response = { v: 1, ok: true, nonce: decoded.request.nonce, relay };
        } else {
          const pairing = await params.buildPairing(boundProfile);
          response =
            pairing.topology === "direct-remote"
              ? { v: 1, ok: false, code: "manual_required" }
              : {
                  v: 1,
                  ok: true,
                  nonce: decoded.request.nonce,
                  pairingString: pairing.pairingString,
                };
        }
      } catch (error) {
        response = {
          v: 1,
          ok: false,
          code:
            decoded.request.op === "ensure_relay"
              ? "relay_unavailable"
              : error instanceof Error && error.message.includes("--gateway-url")
                ? "manual_required"
                : "pairing_unavailable",
        };
      }
    }
  } catch {
    response = { v: 1, ok: false, code: "invalid_frame" };
  }
  return response;
}
