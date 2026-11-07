import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { useAutoCleanupTempDirTracker, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { parseBrowserNativeHostOrigins, runBrowserNativeHost } from "./extension-native-host.js";
import { decodeBrowserNativeFrame, readBrowserNativeFrame } from "./extension-native-protocol.js";
import { ensureExtensionRelayDaemonProcess } from "./extension-relay-daemon-spawn.js";
import { runExtensionRelayDaemon } from "./relay-daemon.js";
import { getFreePort } from "./test-port.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const OTHER_ORIGIN = `chrome-extension://${"p".repeat(32)}/`;
const NONCE = Buffer.alloc(16, 7).toString("base64url");
const PAIRING = `ws://127.0.0.1:18799/extension#${relayTestKey(1)}`;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let defaultFixture: ReturnType<typeof nativeFixture> | undefined;

function lengthHeader(length: number) {
  const header = Buffer.alloc(4);
  header[os.endianness() === "LE" ? "writeUInt32LE" : "writeUInt32BE"](length);
  return header;
}

function frame(payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  return Buffer.concat([lengthHeader(body.length), body]);
}

function requestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, op: "bootstrap", nonce: NONCE, ...overrides });
}

const pairing = async () => ({ pairingString: PAIRING, topology: "local" });
const failure = (code: string) => ({ v: 1, ok: false, code });

async function* chunks(...values: Buffer[]) {
  yield* values;
}

it.each([
  ["truncated body", frame(requestJson()).subarray(0, 8)],
  ["multiple messages", Buffer.concat([frame(requestJson()), frame(requestJson())])],
  ["oversized length before payload allocation", lengthHeader(4 * 1024 + 1)],
])("rejects %s", async (_label, input) => {
  await expect(readBrowserNativeFrame(chunks(input))).rejects.toThrow("invalid_frame");
});

it("returns a complete request without waiting for Chrome to close stdin", async () => {
  const expected = frame(requestJson());
  const openPipe = {
    async *[Symbol.asyncIterator]() {
      yield expected;
      await new Promise<void>(() => {});
    },
  };
  const result = await withTimeout(
    readBrowserNativeFrame(openPipe),
    100,
    "native frame without closing stdin",
  );

  expect(result).toEqual(expected);
});
it.each([
  ["fatal UTF-8", Buffer.from([0xc3, 0x28]), "invalid_utf8"],
  ["array", `[${requestJson()}]`, "invalid_request"],
  ["padded nonce", requestJson({ nonce: `${NONCE}=` }), "invalid_request"],
  ["short nonce", requestJson({ nonce: "AA" }), "invalid_request"],
] as const)("rejects native bootstrap %s", (_label, raw, code) => {
  expect(decodeBrowserNativeFrame(frame(raw))).toEqual({ ok: false, code });
});

async function nativeFixture(allowedOrigins = [ORIGIN]) {
  const root = tempDirs.make("openclaw-native-host-");
  const stateDir = path.join(root, "state");
  const managedDir = path.join(stateDir, "browser", "native-messaging");
  const manifestDir = path.join(root, "chrome", "NativeMessagingHosts");
  await fs.mkdir(managedDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(manifestDir, { recursive: true, mode: 0o700 });
  const launcherPath = path.join(managedDir, "bootstrap.sh");
  const manifestPath = path.join(manifestDir, "ai.openclaw.browser_bootstrap.json");
  await fs.writeFile(launcherPath, "#!/bin/sh\n", { mode: 0o700 });
  const manifest = {
    name: "ai.openclaw.browser_bootstrap",
    description: "OpenClaw browser extension bootstrap",
    path: launcherPath,
    type: "stdio",
    allowed_origins: allowedOrigins,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return { stateDir, launcherPath, manifestPath };
}

async function invokeHost(overrides: Partial<Parameters<typeof runBrowserNativeHost>[0]> = {}) {
  // Callers that mutate manifests or credentials supply their own private fixture.
  const fixture = await (defaultFixture ??= nativeFixture());
  return runBrowserNativeHost({
    ...fixture,
    callerOrigin: ORIGIN,
    expectedOrigins: [ORIGIN],
    input: chunks(frame(requestJson())),
    buildPairing: pairing,
    ensureRelay: async () => "skipped",
    ...overrides,
  });
}

async function expectManifestRejected(fixture: Awaited<ReturnType<typeof nativeFixture>>) {
  const buildPairing = vi.fn(pairing);
  expect(await invokeHost({ ...fixture, buildPairing })).toEqual(failure("manifest_invalid"));
  expect(buildPairing).not.toHaveBeenCalled();
}

const relayInput = (relayPort: number) =>
  chunks(frame(requestJson({ op: "ensure_relay", relayPort })));
const configuredRelay =
  (cfg: Parameters<typeof ensureExtensionRelayDaemonProcess>[0]["cfg"]) => (port: number) =>
    ensureExtensionRelayDaemonProcess({
      port,
      cfg,
      entryPath: "/opt/openclaw/dist/extensions/browser/relay-daemon-entry.js",
    });

it("parses a nonempty sorted unique expected-origin list before the caller origin", () => {
  const expectedOrigins = [ORIGIN, OTHER_ORIGIN];
  expect(
    parseBrowserNativeHostOrigins([
      "--manifest",
      "manifest.json",
      ...expectedOrigins.flatMap((origin) => ["--expected-origin", origin]),
      OTHER_ORIGIN,
    ]),
  ).toEqual({ expectedOrigins, callerOrigin: OTHER_ORIGIN });
});

it.each([
  ["missing value", ["--expected-origin"]],
  ["malformed", ["--expected-origin", "chrome-extension://*/", ORIGIN]],
  ["multiple callers", ["--expected-origin", ORIGIN, ORIGIN, OTHER_ORIGIN]],
])("rejects %s expected-origin arguments", (_label, argv) => {
  expect(() => parseBrowserNativeHostOrigins(argv)).toThrow();
});

it.skipIf(process.platform === "win32")("accepts private hardlinks", async () => {
  const fixture = await nativeFixture();
  for (const file of [fixture.manifestPath, fixture.launcherPath]) {
    await fs.link(file, `${file}.link`);
  }
  expect(await invokeHost(fixture)).toEqual({
    v: 1,
    ok: true,
    nonce: NONCE,
    pairingString: PAIRING,
  });
});

it.skipIf(process.platform === "win32")("rejects unsafe manifest substitution", async () => {
  const fixture = await nativeFixture();
  const replacement = `${fixture.manifestPath}.replacement`;
  await fs.writeFile(replacement, await fs.readFile(fixture.manifestPath), { mode: 0o644 });
  await fs.chmod(replacement, 0o644);
  let substituted = false;
  const substitute = async (file: unknown) => {
    if (file === fixture.manifestPath && !substituted) {
      substituted = true;
      await fs.rename(replacement, fixture.manifestPath);
    }
  };
  const readFile = fs.readFile.bind(fs);
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    await substitute(args[0]);
    return readFile(...args);
  });
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    await substitute(args[0]);
    return open(...args);
  });
  await expectManifestRejected(fixture);
  expect(substituted).toBe(true);
});

it.skipIf(process.platform === "win32")("rejects non-executable launchers", async () => {
  const fixture = await nativeFixture();
  await fs.chmod(fixture.launcherPath, 0o600);
  await expectManifestRejected(fixture);
});

it("rejects a manifest with an extra valid origin before building pairing", async () => {
  await expectManifestRejected(await nativeFixture([ORIGIN, OTHER_ORIGIN]));
});

it("returns manual_required for unsupported topology", async () => {
  await expect(
    invokeHost({
      buildPairing: async () => ({ pairingString: PAIRING, topology: "direct-remote" }),
    }),
  ).resolves.toEqual(failure("manual_required"));
});

it.each([
  ["invalid port", requestJson({ op: "ensure_relay", relayPort: 65536 })],
  [
    "escaped duplicate port",
    `{"v":1,"op":"ensure_relay","nonce":"${NONCE}","relayPort":18799,"relay\\u0050ort":18798}`,
  ],
  ["unknown field", requestJson({ op: "ensure_relay", relayPort: 18799, token: "untrusted" })],
])("rejects %s without invoking the relay launcher", async (_label, raw) => {
  const ensureRelay = vi.fn(async () => "spawned" as const);
  const result = await invokeHost({ input: chunks(frame(raw)), ensureRelay });
  expect(result).toEqual(failure("invalid_request"));
  expect(ensureRelay).not.toHaveBeenCalled();
});

it("rejects the remote browser port before probing or spawning", async () => {
  const probe = vi.spyOn(net, "connect");
  const result = await invokeHost({
    input: relayInput(29443),
    ensureRelay: configuredRelay({
      browser: { profiles: { remote: { cdpUrl: "https://browser.example:29443" } } },
    }),
  });
  expect(result).toEqual(failure("relay_unavailable"));
  expect(probe).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it("wakes the non-first automatic profile through the native frame and config boundary", async () => {
  const fixture = await nativeFixture();
  const relayPort = await getFreePort();
  await fs.mkdir(path.join(fixture.stateDir, "credentials"), { mode: 0o700 });
  await fs.writeFile(
    path.join(fixture.stateDir, "credentials", "browser-extension-relay.secret"),
    relayTestKey(1),
    { mode: 0o600 },
  );
  await withEnvAsync(
    { OPENCLAW_STATE_DIR: fixture.stateDir, OPENCLAW_GATEWAY_PORT: undefined },
    async () => {
      let daemon: ReturnType<typeof runExtensionRelayDaemon> | undefined;
      // Only process creation is mocked; config, credentials and relay stay real.
      vi.mocked(spawn).mockImplementation((_command, args) => {
        daemon = runExtensionRelayDaemon({
          port: Number(Array.isArray(args) ? args[2] : undefined),
        });
        return new ChildProcess();
      });
      try {
        const extension = { driver: "extension" as const };
        const result = await invokeHost({
          ...fixture,
          input: relayInput(relayPort),
          ensureRelay: configuredRelay({
            gateway: { port: relayPort - 9 },
            browser: { profiles: { chrome: extension, work: extension } },
          }),
        });
        expect(result).toEqual({ v: 1, ok: true, nonce: NONCE, relay: "spawned" });
        const run = await daemon;
        expect(run?.port).toBe(relayPort);
        const response = await fetch(`http://127.0.0.1:${relayPort}/json/version`);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "Unauthorized" });
      } finally {
        const run = await daemon;
        run?.stop();
        await run?.done;
      }
    },
  );
});

it("still validates the manifest before ensuring the relay", async () => {
  const ensureRelay = vi.fn(async () => "spawned" as const);
  const result = await invokeHost({
    input: relayInput(18799),
    callerOrigin: OTHER_ORIGIN,
    ensureRelay,
  });
  expect(result).toEqual(failure("origin_forbidden"));
  expect(ensureRelay).not.toHaveBeenCalled();
});
