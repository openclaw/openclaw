import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { TLSSocket } from "node:tls";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";

const scopes = ["operator.read", "operator.talk"];
const systemKeychain = "/Library/Keychains/System.keychain";
const packagePath = "apps/shared/OpenClawKit";
const proofSource = "test/fixtures/ios-watch-operator-https.swift";
const cancelled = new AbortController();

type CommandResult = { code: number | null; stdout: string };
type CommandOptions = {
  input?: string;
  timeout?: number;
  cleanup?: boolean;
  allowFailure?: boolean;
  compilerDiagnostics?: boolean;
  signal?: AbortSignal;
};
type CommandLabel =
  | "swift-build"
  | "swift-bin-path"
  | "swift-link"
  | "driver-identity"
  | "driver-negative"
  | "driver-positive"
  | "certificate-ca"
  | "certificate-request"
  | "certificate-sign"
  | "trust-install"
  | "trust-remove"
  | "trust-diagnostic"
  | "certificate-remove";
type TrustRemovalSample = { available: boolean; exitCode?: number | null; symbols: string[] };
type CommandEvent = {
  label: CommandLabel;
  id: number;
  event: "start" | "exit" | "close";
  elapsedMs: number;
  code: number | null;
  signal: NodeJS.Signals | null;
};
type RunCommand = (
  label: CommandLabel,
  tool: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;
type Stage =
  | "initialize"
  | "compile-production-driver"
  | "driver-identity"
  | "generate-localhost-certificate"
  | "gateway-configuration"
  | "pairing-import"
  | "pairing-approval-import"
  | "pairing-request"
  | "pairing-approval"
  | "pairing-readback"
  | "gateway-import"
  | "gateway-start"
  | "gateway-startup-settled"
  | "negative-system-trust"
  | "install-hosted-localhost-trust"
  | "positive-system-trust"
  | "gateway-close"
  | "trust-removal"
  | "private-state-removal";
type DriverResult = {
  ok: boolean;
  stage?: string;
  deviceID?: string;
  publicKey?: string;
  platform?: string;
  deviceFamily?: string;
  connectionID?: string;
  persistedAuth?: boolean;
  tokenlessHello?: boolean;
  unchangedStoredGrant?: boolean;
  methods?: string[];
  errors?: { domain: string; code: number }[];
};
type Delivery = { route: string; status: number; tls: string | null; connectionID?: string };
type SwiftCommand = {
  moduleName: string;
  objects: string[];
  importPath: string;
  otherArguments: string[];
};

async function command(
  context: {
    label: CommandLabel;
    id: number;
    observe: (event: CommandEvent) => void;
    sample?: (result: TrustRemovalSample) => void;
  },
  tool: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  assert(!options.compilerDiagnostics || (["swift", "swiftc"].includes(tool) && !options.input));
  const started = performance.now();
  const observe = (
    event: CommandEvent["event"],
    code: number | null = null,
    signal: NodeJS.Signals | null = null,
  ) =>
    context.observe({
      label: context.label,
      id: context.id,
      event,
      elapsedMs: Math.round(performance.now() - started),
      code,
      signal,
    });
  observe("start");
  const overflowCancellation = new AbortController();
  let stdout = "";
  let diagnostics = "";
  let bytes = 0;
  let overflow = false;
  let removeObservers = () => {};
  const errors: unknown[] = [];
  let result: CommandResult | undefined;
  const sampleCancellation = new AbortController();
  let sampleTimer: ReturnType<typeof setTimeout> | undefined;
  let sampling = Promise.resolve();
  const stopSampling = () => {
    clearTimeout(sampleTimer);
    sampleCancellation.abort();
  };
  try {
    const code = await runManagedCommand({
      bin: tool,
      args,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.any([
        overflowCancellation.signal,
        ...(options.cleanup ? [] : [cancelled.signal]),
        ...(options.signal ? [options.signal] : []),
      ]),
      timeoutMs: options.timeout ?? 30000,
      requireProcessTreeExit: true,
      timeoutForceKillOnLeaderExit: true,
      onReady: (child) => {
        const { stdin, stdout: output, stderr } = child;
        assert(stdin && output && stderr, "Expected piped command streams");
        const capture = (chunk: Buffer, isOutput: boolean) => {
          bytes += chunk.length;
          if (options.compilerDiagnostics && diagnostics.length < 65536) {
            diagnostics += chunk.toString("utf8").slice(0, 65536 - diagnostics.length);
          }
          if (bytes > 4 * 1024 * 1024) {
            overflow = true;
            overflowCancellation.abort();
          } else if (isOutput) {
            stdout += chunk.toString("utf8");
          }
        };
        const captureOutput = (chunk: Buffer) => capture(chunk, true);
        const captureError = (chunk: Buffer) => capture(chunk, false);
        const exited = (exitCode: number | null, signal: NodeJS.Signals | null) => {
          stopSampling();
          observe("exit", exitCode, signal);
        };
        const closed = (exitCode: number | null, signal: NodeJS.Signals | null) =>
          observe("close", exitCode, signal);
        output.on("data", captureOutput);
        stderr.on("data", captureError);
        child.once("exit", exited);
        child.once("close", closed);
        removeObservers = () => {
          output.off("data", captureOutput);
          stderr.off("data", captureError);
          child.off("exit", exited);
          child.off("close", closed);
        };
        stdin.on("error", () => {});
        stdin.end(options.input);
        if (context.label === "trust-remove") {
          sampleTimer = setTimeout(() => {
            sampling = sampleTrustRemoval(child, sampleCancellation.signal, context.sample).catch(
              (error: unknown) => {
                errors.push(error);
              },
            );
          }, 5000);
        }
      },
    });
    assert(
      !overflow && (options.allowFailure || code === 0),
      `${path.basename(tool)} failed (${code})`,
    );
    result = { code, stdout };
  } catch (error) {
    if (options.compilerDiagnostics) {
      // These commands run before identity/token/CA provisioning. Runtime stderr
      // is never included; retain bounded source diagnostics without runner paths.
      console.error(
        diagnostics
          .replaceAll(process.cwd(), "<checkout>")
          .replace(/\/(?:Users|private|var|tmp|Volumes)\/[^\s:)"']+/g, "<path>"),
      );
    }
    errors.push(error);
  } finally {
    stopSampling();
    removeObservers();
    await sampling;
  }
  // Preserve both owners' failures so unjoined diagnostics fence certificate/private cleanup.
  if (errors.length > 1) {
    throw new AggregateError(errors, "Command and diagnostic cleanup failed");
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  assert(result);
  return result;
}

async function sampleTrustRemoval(
  owner: ChildProcess,
  signal: AbortSignal,
  observe?: (result: TrustRemovalSample) => void,
): Promise<void> {
  const result: TrustRemovalSample = { available: false, symbols: [] };
  try {
    const run = (tool: string, args: string[], sample = false) =>
      command(
        {
          label: "trust-diagnostic",
          id: 0,
          observe: (event) => {
            if (sample && event.event === "exit") {
              result.exitCode = event.code;
            }
          },
        },
        tool,
        args,
        { cleanup: true, allowFailure: true, signal, timeout: 5000 },
      );
    const requireLiveOwner = () => {
      signal.throwIfAborted();
      assert(owner.pid && owner.exitCode === null && owner.signalCode === null, "Owner exited");
    };
    const ancestry = async () => {
      requireLiveOwner();
      const { code, stdout } = await run("/bin/ps", ["-ww", "-axo", "pid=,ppid=,lstart=,comm="]);
      requireLiveOwner();
      assert.equal(code, 0);
      const rows = stdout.split(/\r?\n/u).flatMap((line) => {
        const match =
          /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u.exec(
            line,
          );
        return match
          ? [{ pid: Number(match[1]), ppid: Number(match[2]), start: match[3], comm: match[4] }]
          : [];
      });
      const byPID = new Map(rows.map((row) => [row.pid, row]));
      const root = byPID.get(owner.pid!);
      assert(root?.ppid === process.pid, "Owner ancestry unavailable");
      const matches = rows
        .filter((row) => row.comm === "/usr/bin/security")
        .flatMap((row) => {
          const chain: typeof rows = [];
          let current: (typeof rows)[number] | undefined = row;
          while (current && !chain.includes(current)) {
            chain.push(current);
            if (current === root) {
              return [chain];
            }
            current = byPID.get(current.ppid);
            if (current?.comm !== "/usr/bin/sudo") {
              break;
            }
          }
          return [];
        });
      assert.equal(matches.length, 1, "Security ancestry is missing or ambiguous");
      return matches[0]!;
    };
    const before = await ancestry();
    requireLiveOwner();
    // Sampling briefly suspends the target; symbols locate a stage, not proof of a prompt.
    const sampled = await run(
      "/usr/bin/sudo",
      ["-n", "/usr/bin/sample", String(before[0]!.pid), "1", "1", "-file", "/dev/stdout"],
      true,
    );
    const after = await ancestry();
    requireLiveOwner();
    assert(JSON.stringify(before) === JSON.stringify(after), "Security owner changed");
    assert(
      sampled.code === 0 && result.exitCode === 0 && /^Call graph:\s*$/mu.test(sampled.stdout),
    );
    result.symbols = [
      "AuthorizationCopyRights",
      "SecTrustSettingsXPCWrite",
      "SecTrustStoreSetTrustSettings",
    ].filter((symbol) => new RegExp(`\\b${symbol}\\b`, "u").test(sampled.stdout));
    result.available = true;
  } catch (error) {
    if (hasUnjoinedWork(error)) {
      throw error;
    }
  } finally {
    observe?.(result);
  }
}

async function compileDriver(
  scratch: string,
  executable: string,
  runCommand: RunCommand,
): Promise<void> {
  await runCommand(
    "swift-build",
    "swift",
    [
      "build",
      "--package-path",
      packagePath,
      "--scratch-path",
      scratch,
      "--target",
      "OpenClawKit",
      "--jobs",
      "4",
    ],
    { timeout: 300000, compilerDiagnostics: true },
  );
  const { stdout } = await runCommand("swift-bin-path", "swift", [
    "build",
    "--package-path",
    packagePath,
    "--scratch-path",
    scratch,
    "--show-bin-path",
  ]);
  const bin = await realpath(stdout.trim());
  const description: {
    swiftCommands: Record<string, SwiftCommand>;
    targetDependencyMap: Record<string, string[]>;
  } = JSON.parse(await readFile(path.join(bin, "description.json"), "utf8"));
  // Use SwiftPM's actual production dependency closure, never test objects or a filesystem glob.
  const modules = new Set(["OpenClawKit"]);
  for (const name of modules) {
    assert(!name.includes("Test"), "Test target in production link closure");
    for (const dependency of description.targetDependencyMap[name] ?? []) {
      modules.add(dependency);
    }
  }
  const objects: string[] = [];
  let root: SwiftCommand | undefined;
  for (const name of modules) {
    const matches = Object.values(description.swiftCommands).filter(
      (entry) => entry.moduleName === name,
    );
    assert.equal(matches.length, 1, `Missing or ambiguous production module: ${name}`);
    const entry = matches[0];
    assert(entry && entry.objects.length > 0);
    if (name === "OpenClawKit") {
      root = entry;
    }
    for (const object of entry.objects) {
      assert(
        object.startsWith(`${bin}${path.sep}`) && object.endsWith(".o"),
        "Object outside build manifest",
      );
      objects.push(object);
    }
  }
  assert(root);
  const compilerArgs = ["-swift-version", "6", "-parse-as-library", "-I", root.importPath];
  for (const flag of ["-target", "-sdk"]) {
    const value: string | undefined = root.otherArguments[root.otherArguments.indexOf(flag) + 1];
    assert(value && root.otherArguments.includes(flag), `Missing SwiftPM ${flag}`);
    compilerArgs.push(flag, value);
  }
  await runCommand(
    "swift-link",
    "swiftc",
    [...compilerArgs, proofSource, ...objects, "-lsqlite3", "-o", executable],
    {
      timeout: 120000,
      compilerDiagnostics: true,
    },
  );
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function main(): Promise<void> {
  assert(
    process.platform === "darwin" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "This proof changes certificate trust only on a disposable GitHub-hosted macOS runner",
  );
  const started = performance.now();
  console.log(JSON.stringify({ stage: "initialize", phase: "before", elapsedMs: 0 }));
  const runnerTemp = await realpath(process.env.RUNNER_TEMP ?? "");
  const output = path.join(runnerTemp, "watch-qualification");
  const privateRoot = path.join(runnerTemp, `watch-https-private-${randomUUID()}`);
  const scratch = path.join(runnerTemp, "watch-qualification-swift");
  await mkdir(output, { recursive: true });
  await mkdir(privateRoot, { mode: 0o700 });
  process.umask(0o077);
  const gatewayState = path.join(privateRoot, "gateway");
  const swiftState = path.join(privateRoot, "swift");
  const home = path.join(privateRoot, "home");
  await Promise.all([gatewayState, swiftState, home].map((dir) => mkdir(dir, { mode: 0o700 })));

  // Select isolation before importing any runtime module that can capture a state/config root.
  const inherited = new Set(["PATH", "TMPDIR", "DEVELOPER_DIR", "SDKROOT", "LANG", "LC_ALL"]);
  for (const key of Object.keys(process.env)) {
    if (!inherited.has(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    OPENCLAW_STATE_DIR: gatewayState,
    OPENCLAW_CONFIG_PATH: path.join(gatewayState, "openclaw.json"),
  });
  const report: Record<string, unknown> = { ok: false, node: process.version, stages: [] };
  const stages: Stage[] = ["initialize"];
  report.stages = stages;
  const receiptPath = path.join(output, "operator-https.json");
  const receiptTemporaryPath = path.join(output, ".operator-https.json.tmp");
  let receiptWrites: Promise<void> = Promise.resolve();
  let receiptWriteFailed = false;
  const writeReceipt = (): Promise<void> => {
    // Snapshot on admission; queued writes must not observe later stage mutations.
    const snapshot = `${JSON.stringify(report, null, 2)}\n`;
    const write = receiptWrites.then(async () => {
      await writeFile(receiptTemporaryPath, snapshot, { mode: 0o600 });
      await rename(receiptTemporaryPath, receiptPath);
    });
    receiptWrites = write.catch(() => {
      if (!receiptWriteFailed) {
        console.error("Operator HTTPS receipt write failed");
      }
      receiptWriteFailed = true;
    });
    return write;
  };
  const checkpoint = async (stage: Stage, phase: "before" | "after"): Promise<void> => {
    if (phase === "before") {
      stages.push(stage);
    }
    const event = { stage, phase, elapsedMs: Math.round(performance.now() - started) };
    report.progress = event;
    console.log(JSON.stringify(event));
    await writeReceipt();
  };
  let commandID = 0;
  const runCommand: RunCommand = (label, tool, args, options) =>
    command(
      {
        label,
        id: ++commandID,
        observe: (event) => {
          report.child = event;
          console.log(JSON.stringify(event));
          void writeReceipt().catch(() => {});
        },
        sample: (result) => {
          report.trustRemovalSample = result;
          console.log(JSON.stringify({ trustRemovalSample: result }));
          void writeReceipt().catch(() => {});
        },
      },
      tool,
      args,
      options,
    );
  const deliveries: Delivery[] = [];
  let overflow = false;
  let gateway:
    | Awaited<ReturnType<typeof import("../src/gateway/server.js").startGatewayServer>>
    | undefined;
  let trustAttempted = false;
  let fingerprint = "";
  let subscribed = false;
  let port = 0;
  const ca = path.join(privateRoot, "ca.pem");
  const responseFinish = channel("http.server.response.finish");
  const observe = (message: unknown) => {
    const { request, response, socket } = message as {
      request: IncomingMessage;
      response: ServerResponse;
      socket: TLSSocket;
    };
    if (!(socket instanceof TLSSocket) || socket.localPort !== port) {
      return;
    }
    const match = /^\/api\/operator\/connections(?:\/([^/?]+)(?:\/(frames|poll))?)?$/.exec(
      request.url ?? "",
    );
    if (!match) {
      return;
    }
    if (deliveries.length >= 128) {
      overflow = true;
      return;
    }
    deliveries.push({
      route: request.method === "DELETE" ? "delete" : (match[2] ?? "begin"),
      status: response.statusCode,
      tls: socket.getProtocol(),
      connectionID: match[1],
    });
  };
  const interrupt = () => cancelled.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let failure = false;
  let failureStage: Stage | undefined;
  const errors: unknown[] = [];
  try {
    await checkpoint("initialize", "after");
    await checkpoint("compile-production-driver", "before");
    const executable = path.join(privateRoot, "operator-https");
    await compileDriver(scratch, executable, runCommand);
    await checkpoint("compile-production-driver", "after");
    const driver = async (mode: "identity" | "negative" | "positive", input?: object) => {
      const result = await runCommand(`driver-${mode}`, executable, [mode, swiftState], {
        input: input ? JSON.stringify(input) : undefined,
        timeout: 90000,
        allowFailure: true,
      });
      assert(Buffer.byteLength(result.stdout) <= 16384, "Driver output exceeds bound");
      const value: DriverResult = JSON.parse(result.stdout);
      if (result.code !== 0 || !value.ok) {
        // The driver emits only allowlisted stages and numeric error metadata.
        report.driverFailure = { stage: value.stage, errors: value.errors };
        throw new Error("Foundation driver failed");
      }
      return value;
    };
    await checkpoint("driver-identity", "before");
    const identity = await driver("identity");
    assert(identity.deviceID && identity.publicKey && identity.platform && identity.deviceFamily);
    await checkpoint("driver-identity", "after");
    await checkpoint("generate-localhost-certificate", "before");
    const caKey = path.join(privateRoot, "ca.key");
    const leafKey = path.join(privateRoot, "leaf.key");
    const csr = path.join(privateRoot, "leaf.csr");
    const cert = path.join(privateRoot, "leaf.pem");
    const ext = path.join(privateRoot, "leaf.ext");
    await runCommand("certificate-ca", "openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      `/CN=OpenClaw HTTPS proof ${randomUUID()}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      caKey,
      "-out",
      ca,
    ]);
    fingerprint = new X509Certificate(await readFile(ca)).fingerprint256.replaceAll(":", "");
    await runCommand("certificate-request", "openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      "/CN=localhost",
      "-keyout",
      leafKey,
      "-out",
      csr,
    ]);
    await writeFile(
      ext,
      [
        "basicConstraints=critical,CA:FALSE",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        "",
      ].join("\n"),
    );
    await runCommand("certificate-sign", "openssl", [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      ext,
      "-out",
      cert,
    ]);
    await checkpoint("generate-localhost-certificate", "after");
    await checkpoint("gateway-configuration", "before");
    port = await reservePort();
    await writeFile(
      process.env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth: { mode: "token", token: randomBytes(32).toString("base64url") },
          tailscale: { mode: "off" },
          controlUi: { enabled: false },
          tls: { enabled: true, autoGenerate: false, certPath: cert, keyPath: leafKey, caPath: ca },
        },
        agents: { list: [{ id: "proof", workspace: path.join(privateRoot, "workspace") }] },
        logging: {
          level: "silent",
          consoleLevel: "silent",
          file: path.join(privateRoot, "gateway.log"),
        },
      }),
    );
    await checkpoint("gateway-configuration", "after");
    await checkpoint("pairing-import", "before");
    const { requestDevicePairing, getPairedDevice } =
      await import("../src/infra/device-pairing.js");
    await checkpoint("pairing-import", "after");
    await checkpoint("pairing-approval-import", "before");
    const { approveDevicePairing } = await import("../src/infra/device-pairing-approval.js");
    await checkpoint("pairing-approval-import", "after");
    await checkpoint("pairing-request", "before");
    const request = await requestDevicePairing(
      {
        deviceId: identity.deviceID,
        publicKey: identity.publicKey,
        platform: identity.platform,
        deviceFamily: identity.deviceFamily,
        clientId: "openclaw-watchos",
        clientMode: "node",
        role: "operator",
        scopes,
      },
      gatewayState,
    );
    await checkpoint("pairing-request", "after");
    await checkpoint("pairing-approval", "before");
    const approved = await approveDevicePairing(
      request.request.requestId,
      {
        callerScopes: scopes,
        approvedVia: "owner",
      },
      gatewayState,
    );
    assert(approved?.status === "approved");
    const grant = approved.device.tokens?.operator;
    assert(grant && grant.token && grant.role === "operator");
    assert.deepEqual(grant.scopes, scopes);
    await checkpoint("pairing-approval", "after");
    await checkpoint("pairing-readback", "before");
    const paired = await getPairedDevice(identity.deviceID, gatewayState);
    assert.equal(paired?.approvedVia, "owner");
    assert.equal(paired?.tokens?.operator?.token, grant.token);
    await checkpoint("pairing-readback", "after");
    const input = {
      endpoint: `https://localhost:${port}`,
      gatewayID: `watch-direct:https://localhost:${port}`,
      deviceID: identity.deviceID,
      token: grant.token,
    };
    await checkpoint("gateway-import", "before");
    const { startGatewayServer } = await import("../src/gateway/server.js");
    await checkpoint("gateway-import", "after");
    await checkpoint("gateway-start", "before");
    gateway = await startGatewayServer(port, { host: "127.0.0.1", updateCanary: true });
    await checkpoint("gateway-start", "after");
    await checkpoint("gateway-startup-settled", "before");
    await gateway.startupSettled;
    await checkpoint("gateway-startup-settled", "after");
    responseFinish.subscribe(observe);
    subscribed = true;
    await checkpoint("negative-system-trust", "before");
    const negative = await driver("negative", input);
    assert.equal(negative.stage, "untrusted-certificate-rejected");
    assert.equal(negative.persistedAuth, true);
    assert.equal(deliveries.length, 0, "Operator HTTP reached Gateway before CA trust");
    report.negative = { persistedAuth: true, errors: negative.errors, operatorResponses: 0 };
    await checkpoint("negative-system-trust", "after");

    await checkpoint("install-hosted-localhost-trust", "before");
    trustAttempted = true;
    await runCommand("trust-install", "/usr/bin/sudo", [
      "/usr/bin/security",
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-p",
      "ssl",
      "-s",
      "localhost",
      "-k",
      systemKeychain,
      ca,
    ]);
    await checkpoint("install-hosted-localhost-trust", "after");
    await checkpoint("positive-system-trust", "before");
    const positive = await driver("positive", input);
    assert.equal(positive.tokenlessHello, true);
    assert.equal(positive.unchangedStoredGrant, true);
    assert.deepEqual(positive.methods, ["agents.list", "sessions.list"]);
    assert(positive.connectionID && !overflow);
    assert.equal(
      deliveries.filter((event) => event.route === "begin" && event.status === 201).length,
      1,
    );
    assert(deliveries.every((event) => event.tls === "TLSv1.3"));
    assert(deliveries.some((event) => event.route === "frames" && event.status === 202));
    assert(deliveries.some((event) => event.route === "poll" && event.status === 200));
    assert(
      deliveries.some(
        (event) =>
          event.route === "delete" &&
          event.status === 204 &&
          event.connectionID === positive.connectionID,
      ),
      "No completed DELETE 204 for the actor connection",
    );
    report.positive = {
      tokenlessHello: true,
      unchangedStoredGrant: true,
      methods: positive.methods,
      responses: deliveries.map(({ route, status, tls }) => ({ route, status, tls })),
    };
    await checkpoint("positive-system-trust", "after");
  } catch (error) {
    errors.push(error);
    failure = true;
    failureStage = stages.at(-1);
    report.failureStage = failureStage;
  } finally {
    const cleanupFailures: string[] = [];
    report.cleanupFailures = cleanupFailures;
    if (subscribed) {
      responseFinish.unsubscribe(observe);
    }
    const cleanup = async (stage: Stage, operation: () => Promise<unknown>): Promise<void> => {
      // Evidence failure must not stop either resource owner from beginning cleanup.
      const before = checkpoint(stage, "before").catch(() => {});
      try {
        await operation();
      } catch (error) {
        errors.push(error);
        cleanupFailures.push(stage);
      }
      await before;
      await checkpoint(stage, "after").catch(() => {});
    };
    const closingGateway = gateway;
    const gatewayClose = closingGateway
      ? cleanup("gateway-close", () =>
          closingGateway.close({ reason: "qualification complete", drainTimeoutMs: 1000 }),
        )
      : Promise.resolve();
    const trustRemoval = trustAttempted
      ? cleanup("trust-removal", async () => {
          const commands: [CommandLabel, string[]][] = [
            ["trust-remove", ["/usr/bin/security", "remove-trusted-cert", "-d", ca]],
            [
              "certificate-remove",
              ["/usr/bin/security", "delete-certificate", "-Z", fingerprint, systemKeychain],
            ],
          ];
          for (const [label, args] of commands) {
            // A still-running privileged command owns these certificate inputs.
            // Do not race it with another trust mutation, including after timeout.
            if (errors.some(hasUnjoinedWork)) {
              break;
            }
            try {
              await runCommand(label, "/usr/bin/sudo", args, { cleanup: true });
            } catch (error) {
              errors.push(error);
              cleanupFailures.push(label);
            }
          }
        })
      : Promise.resolve();
    const settled = await Promise.allSettled([gatewayClose, trustRemoval]);
    for (const result of settled) {
      if (result.status === "rejected") {
        errors.push(result.reason);
        cleanupFailures.push("cleanup-join");
      }
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    const unjoined = errors.some(hasUnjoinedWork);
    report.unjoined = unjoined;
    report.privateStateRetained = true;
    if (!unjoined) {
      await cleanup("private-state-removal", async () => {
        await rm(privateRoot, { recursive: true, force: true });
        report.privateStateRetained = false;
      });
    }
    // Command observers are detached and cleanup attempts have settled. Drain
    // their receipts before the terminal snapshot, including an unjoined failure.
    await receiptWrites;
    report.receiptWriteFailed = receiptWriteFailed;
    report.ok =
      !failure &&
      !unjoined &&
      !cancelled.signal.aborted &&
      !receiptWriteFailed &&
      cleanupFailures.length === 0;
    await writeReceipt();
  }
  assert.equal(
    report.ok,
    true,
    `Operator HTTPS qualification failed at ${failureStage ?? stages.at(-1)}; see operator-https.json`,
  );
}

await main();
