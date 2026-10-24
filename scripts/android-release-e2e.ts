import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { callGateway } from "../src/gateway/call.js";
import { registerSealedRuntimeProcessEntrypoint } from "../src/infra/runtime-process-url.js";
import { createOpenClawTestInstance } from "../test/helpers/openclaw-test-instance.js";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import {
  androidReleaseCommandFacts,
  androidReleaseErrorFacts,
  androidReleaseNativeFacts,
} from "./lib/android-release-e2e-diagnostics.js";
import {
  ANDROID_RELEASE_APPLICATION_ID,
  ANDROID_RELEASE_LONG_REPLY,
  androidReleaseProviderEvidence,
  inspectAndroidReleaseApks,
  androidReleaseSourceEvidence,
  androidReleaseTransportSnapshot,
  requireAndroidReleaseTransportEvidence,
  type AndroidReleaseTransportSnapshot,
} from "./lib/android-release-e2e-evidence.js";
import { prepareIOSReleaseGateway } from "./lib/ios-release-gateway.js";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  getStandaloneRuntimeProcessOutputOptions,
  standaloneRuntimeProcessBuildEntries,
} from "./lib/runtime-process-core-build-entries.mts";
import { resolveAndroidSdkEnv } from "./run-android-gradle.mts";

const repo = resolveRepoRoot(import.meta.url);
const applicationId = ANDROID_RELEASE_APPLICATION_ID;
const vsockPacketBytes = 16384;
const vsockParameter = "vmw_vsock_virtio_transport_common.virtio_transport_max_vsock_pkt_buf_size";

type Device = {
  role: "phone" | "wear";
  serial: string;
  port: number;
  forward: number;
  name: string;
};
type Evidence = {
  schema: number;
  status: "failed" | "passed";
  targetSha: string;
  source: { clean: boolean; diffSha256?: string };
  phases: string[];
  coverage: string;
  exclusions: string[];
  gateway?: unknown;
  artifacts?: unknown;
  transport?: unknown[];
  provider?: unknown;
  emulators?: unknown;
  failure?: string;
  diagnostics: { stage: string; kind: string; details: unknown }[];
  cleanupConfirmed: boolean;
};

async function availablePort(port: number) {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
    options: {
      "target-sha": { type: "string" },
      output: { type: "string" },
      "artifacts-dir": { type: "string" },
      "selection-dir": { type: "string" },
      "allow-dirty": { type: "boolean", default: false },
    },
  });
  if (!values.output || !/^[a-f0-9]{40}$/u.test(values["target-sha"] ?? "")) {
    throw new Error(
      "usage: --target-sha <full-sha> --output <proof.json> [--artifacts-dir <directory>] [--selection-dir <directory>]",
    );
  }
  if (
    !["linux", "darwin"].includes(process.platform) ||
    (process.platform === "linux" && process.arch !== "x64")
  ) {
    throw new Error(
      "Android release validation requires Linux x64 KVM or a macOS SDK emulator host.",
    );
  }
  process.umask(0o077);
  const output = path.resolve(values.output);
  const artifactsDir = path.resolve(values["artifacts-dir"] ?? `${output}.artifacts`);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(path.join(artifactsDir, "screenshots"), { recursive: true });
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-android-release-"));
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let stage = "source";
  let closing = false;
  let unexpectedExit = false;
  let preserveRoot = false;
  const services: { stop: AbortController; done: Promise<void> }[] = [];
  const devices: Device[] = [];
  const evidence: Evidence = {
    schema: 1,
    status: "failed",
    targetSha: values["target-sha"]!,
    source: { clean: false },
    phases: [],
    coverage:
      "Native phone and Wear application behavior through a controlled Google Data Layer boundary, real protocol, phone bridge/controller, published Gateway and local provider.",
    exclusions: [
      "Google capability discovery",
      "WearableListenerService delivery",
      "Play services package/signature enforcement",
      "physical hardware, voice, realtime audio, notifications, Tiles and performance",
    ],
    cleanupConfirmed: false,
    diagnostics: [],
  };
  const diagnostic = (kind: string, details: unknown) => {
    if (evidence.diagnostics.length === 16) {
      evidence.diagnostics.shift();
    }
    evidence.diagnostics.push({ stage, kind, details });
  };
  const sdkEnv = resolveAndroidSdkEnv();
  const sdk =
    sdkEnv.ANDROID_HOME ??
    sdkEnv.ANDROID_SDK_ROOT ??
    path.join(os.homedir(), process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
  const env = {
    ...sdkEnv,
    JAVA_HOME: process.env.OPENCLAW_GRADLE_JAVA_HOME ?? process.env.JAVA_HOME,
    ANDROID_AVD_HOME: path.join(root, "avd"),
    ANDROID_USER_HOME: path.join(root, "android"),
  };
  const adb = path.join(sdk, "platform-tools/adb");
  let commandIndex = 0;
  async function command(
    bin: string,
    args: string[],
    timeoutMs = 60_000,
    extra: { input?: string; cleanup?: boolean; binaryFile?: string } = {},
  ) {
    let stdout = "";
    let stderr = "";
    const binary: Buffer[] = [];
    const index = ++commandIndex;
    const startedAt = Date.now();
    let code: number;
    try {
      code = await runManagedCommand({
        bin,
        args,
        cwd: repo,
        env,
        timeoutMs,
        shell: false,
        signal: extra.cleanup ? undefined : abort.signal,
        stdio: [extra.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        requireProcessTreeExit: true,
        onReady(child) {
          if (extra.input !== undefined) {
            child.stdin?.end(extra.input);
          }
          child.stdout?.on("data", (chunk: Buffer) => {
            if (extra.binaryFile) {
              binary.push(chunk);
            } else {
              stdout = (stdout + chunk.toString()).slice(-16 * 1024 * 1024);
            }
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-16 * 1024 * 1024);
          });
        },
      });
    } catch (error) {
      if (!extra.cleanup) {
        diagnostic("command", {
          ...androidReleaseCommandFacts(bin, args, stdout, stderr),
          ...androidReleaseErrorFacts(error),
          elapsedMs: Date.now() - startedAt,
        });
      }
      throw error;
    }
    await writeFile(path.join(root, `command-${index}.private.log`), stdout + stderr);
    if (extra.binaryFile) {
      await writeFile(extra.binaryFile, Buffer.concat(binary));
    }
    if (code !== 0) {
      if (!extra.cleanup) {
        diagnostic("command", {
          ...androidReleaseCommandFacts(bin, args, stdout, stderr),
          exitCode: code,
          elapsedMs: Date.now() - startedAt,
        });
      }
      throw new Error(`command-exit-${code}`);
    }
    return stdout.trim();
  }
  const deviceCommand = (device: Device, args: string[], timeoutMs = 60_000, cleanup = false) =>
    command(adb, ["-s", device.serial, ...args], timeoutMs, { cleanup });
  function service(
    bin: string,
    args: string[],
    childEnv: NodeJS.ProcessEnv,
    onOutput?: (chunk: string) => void,
  ) {
    const stop = new AbortController();
    const index = ++commandIndex;
    let raw = "";
    const done = runManagedCommand({
      bin,
      args,
      cwd: repo,
      env: childEnv,
      shell: false,
      signal: AbortSignal.any([abort.signal, stop.signal]),
      stdio: ["ignore", "pipe", "pipe"],
      requireProcessTreeExit: true,
      onReady(child) {
        for (const stream of [child.stdout, child.stderr]) {
          stream?.on("data", (chunk: Buffer) => {
            raw = (raw + chunk.toString()).slice(-16 * 1024 * 1024);
            onOutput?.(chunk.toString());
          });
        }
      },
    })
      .then((code) => {
        if (!closing && !stop.signal.aborted) {
          unexpectedExit = true;
          abort.abort();
        }
        if (code !== 0 && !stop.signal.aborted) {
          throw new Error(`service-exit-${code}`);
        }
      })
      .catch((error: unknown) => {
        if (hasUnjoinedWork(error)) {
          preserveRoot = true;
        }
        if (!(stop.signal.aborted || closing) || hasUnjoinedWork(error)) {
          throw error;
        }
      })
      .then(
        async () => {
          await writeFile(path.join(root, `service-${index}.private.log`), raw);
        },
        async (error: unknown) => {
          await writeFile(path.join(root, `service-${index}.private.log`), raw);
          throw error;
        },
      );
    void done.catch(() => {
      if (!closing) {
        unexpectedExit = true;
        abort.abort();
      }
    });
    const handle = { stop, done };
    services.push(handle);
    return handle;
  }
  const phase = (name: string) => {
    stage = name;
    process.stdout.write(`Android release validation: ${name}\n`);
  };
  async function poll<T>(check: () => Promise<T | undefined>, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      abort.signal.throwIfAborted();
      const result = await check();
      if (result !== undefined) {
        return result;
      }
      await sleep(500, undefined, { signal: abort.signal });
    }
    throw new Error("readiness-timeout");
  }
  let instance: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
  const transports: AndroidReleaseTransportSnapshot[] = [];
  evidence.transport = transports;
  try {
    if ((await command("git", ["rev-parse", "HEAD"])) !== evidence.targetSha) {
      throw new Error("source-head-mismatch");
    }
    evidence.source = await androidReleaseSourceEvidence(command, repo);
    if (
      !evidence.source.clean &&
      (!values["allow-dirty"] || process.env.GITHUB_ACTIONS === "true")
    ) {
      throw new Error("dirty-source");
    }
    phase("build");
    await command(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/run-android-gradle.mts",
        ":app:assemblePlayDebug",
        ":app:assemblePlayDebugAndroidTest",
        ":wear:assembleDebug",
        ":wear:assembleDebugAndroidTest",
        "--no-daemon",
        "--max-workers=2",
      ],
      1_200_000,
    );
    async function apk(relative: string) {
      const directory = path.join(repo, "apps/android", relative);
      const metadata = JSON.parse(
        await readFile(path.join(directory, "output-metadata.json"), "utf8"),
      ) as { elements: { outputFile: string }[] };
      if (metadata.elements.length !== 1) {
        throw new Error("ambiguous-apk");
      }
      return path.join(directory, metadata.elements[0]!.outputFile);
    }
    const phoneApk = await apk("app/build/outputs/apk/play/debug");
    const phoneTest = await apk("app/build/outputs/apk/androidTest/play/debug");
    const wearApk = await apk("wear/build/outputs/apk/debug");
    const wearTest = await apk("wear/build/outputs/apk/androidTest/debug");
    phase("artifact-checks");
    const buildTools = (await readdir(path.join(sdk, "build-tools"))).toSorted((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    )[0];
    if (!buildTools) {
      throw new Error("build-tools-missing");
    }
    const tool = (name: string) => path.join(sdk, "build-tools", buildTools, name);
    evidence.artifacts = await inspectAndroidReleaseApks({ command, tool, phoneApk, wearApk });
    phase("gateway-install");
    const gateway = await prepareIOSReleaseGateway({
      selectionDir: path.resolve(values["selection-dir"] ?? `${output}.gateway-selection`),
      installDir: path.join(root, "gateway-install"),
      targetSha: evidence.targetSha,
      signal: abort.signal,
    });
    evidence.gateway = gateway.identity;
    const requestLog = path.join(root, "requests.private.jsonl");
    const responseControl = path.join(root, "response-control.json");
    async function configureProvider(long = false) {
      await writeFile(
        `${responseControl}.tmp`,
        JSON.stringify({
          models: {
            "android-utility": { text: "Synthetic utility result" },
            ...(long
              ? { "android-e2e": { text: ANDROID_RELEASE_LONG_REPLY, chunkDelayMs: 10 } }
              : {}),
          },
        }),
      );
      await rename(`${responseControl}.tmp`, responseControl);
    }
    await configureProvider();
    const providerEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      TMPDIR: root,
      LANG: process.env.LANG,
      MOCK_PORT: "0",
      MOCK_BIND_HOST: "127.0.0.1",
      MOCK_REQUEST_LOG: requestLog,
      MOCK_RESPONSE_CONTROL: responseControl,
    };
    let mockPort: number | undefined;
    let mockOutput = "";
    if (process.platform === "linux") {
      phase("gateway-process-owner");
      // Linux custody requires a built subreaper without loader children. Compile
      // this target's owner so its protocol matches the source-loaded fixture.
      const name = "process/supervisor/service-child-group-anchor";
      const entry = standaloneRuntimeProcessBuildEntries[name];
      if (!entry) {
        throw new Error("gateway-process-owner-entry-missing");
      }
      const outDir = path.join(root, "process-owner", "dist");
      await symlink(path.join(repo, "node_modules"), path.join(root, "node_modules"), "dir");
      const { build } = await import("tsdown");
      await build({
        config: false,
        cwd: repo,
        entry: { [name]: entry },
        outDir,
        format: "esm",
        platform: "node",
        tsconfig: path.join(repo, "tsconfig.json"),
        dts: false,
        envPrefix: [],
        clean: false,
        outExtensions: () => ({ js: ".js" }),
        outputOptions: getStandaloneRuntimeProcessOutputOptions(name),
        logLevel: "warn",
      });
      registerSealedRuntimeProcessEntrypoint(
        "serviceChildGroupAnchor",
        pathToFileURL(path.join(outDir, `${name}.js`)),
      );
    }
    phase("gateway-start");
    service(
      process.execPath,
      [path.join(repo, "scripts/e2e/mock-openai-server.mjs")],
      providerEnv,
      (chunk) => {
        mockOutput = (mockOutput + chunk).slice(-4096);
        const match = /mock-openai listening on (\d+)/u.exec(mockOutput);
        if (match) {
          mockPort = Number(match[1]);
        }
      },
    );
    // Scheduled turns would add unrelated provider calls to this application proof.
    const config = { gateway: { controlUi: { enabled: false } }, cron: { enabled: false } };
    applyMockOpenAiModelConfig(config, {
      mockPort: await poll(async () => mockPort, 30_000),
      modelRef: "openai/android-e2e",
      utilityModelRef: "openai/android-utility",
    });
    const fixtureOwnedKeys = new Set([
      "HOME",
      "USERPROFILE",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_AGENT_DIR",
    ]);
    const allowedGatewayKeys = new Set([
      "PATH",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "USER",
      "LOGNAME",
      "SHELL",
    ]);
    const clearedGatewayEnv = Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => !fixtureOwnedKeys.has(key) && !allowedGatewayKeys.has(key))
        .map((key) => [key, undefined]),
    );
    instance = await createOpenClawTestInstance({
      name: "android-release-validation",
      cwd: gateway.cwd,
      entrypoint: gateway.entrypoint,
      config,
      env: {
        ...clearedGatewayEnv,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_CHANNELS: "0",
        OPENCLAW_SKIP_PROVIDERS: "0",
        OPENAI_API_KEY: "android-release-synthetic-key",
      },
      signal: abort.signal,
    });
    await instance.startGateway();
    instance.child?.once("exit", () => {
      if (!closing) {
        unexpectedExit = true;
        abort.abort();
      }
    });
    const rpc = <T>(method: string, params: Record<string, unknown>) =>
      callGateway<T>({
        config: {},
        configPath: instance!.configPath,
        url: instance!.url,
        token: instance!.gatewayToken,
        ignoreEnvUrlOverride: true,
        deviceIdentity: null,
        sharedStateMode: "read-only",
        method,
        params,
        signal: abort.signal,
        timeoutMs: 30_000,
      });
    await rpc("device.pair.setupStatus", { setupId: randomUUID() });
    phase("emulators");
    await mkdir(env.ANDROID_AVD_HOME, { recursive: true });
    await mkdir(env.ANDROID_USER_HOME, { recursive: true });
    const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
    for (const role of ["phone", "wear"] as const) {
      let port = 5580;
      while (
        !(await availablePort(port)) ||
        !(await availablePort(port + 1)) ||
        devices.some((d) => d.port === port)
      ) {
        port += 2;
        if (port > 5680) {
          throw new Error("no-emulator-port");
        }
      }
      const name = `release-${role}`;
      const image = `system-images;android-${role === "phone" ? "36;google_apis" : "34;android-wear"};${abi}`;
      await command(
        path.join(sdk, "cmdline-tools/latest/bin/avdmanager"),
        [
          "create",
          "avd",
          "--name",
          name,
          "--package",
          image,
          "--device",
          role === "phone" ? "pixel_6" : "wearos_small_round",
        ],
        60_000,
        { input: "no\n" },
      );
      const device: Device = { role, serial: `emulator-${port}`, port, forward: 0, name };
      devices.push(device);
      service(
        path.join(sdk, "emulator/emulator"),
        [
          "-avd",
          name,
          "-port",
          String(port),
          "-no-window",
          "-no-audio",
          "-no-boot-anim",
          "-no-snapshot",
          "-gpu",
          "swiftshader",
          "-cores",
          "2",
          "-memory",
          role === "phone" ? "2048" : "1024",
          // 64 KiB VSOCK packets can fail contiguous guest allocations and disconnect ADB.
          "-qemu",
          "-append",
          `${vsockParameter}=${vsockPacketBytes}`,
        ],
        env,
      );
      await poll(async () => {
        try {
          return (await deviceCommand(
            device,
            ["shell", "getprop", "sys.boot_completed"],
            10_000,
          )) === "1"
            ? true
            : undefined;
        } catch {
          return undefined;
        }
      }, 300_000);
      if (!(await deviceCommand(device, ["emu", "avd", "name"])).split(/\r?\n/u).includes(name)) {
        throw new Error("emulator-identity-mismatch");
      }
      phase(`${role}-vsock-limit`);
      const packetLimit = await deviceCommand(device, [
        "shell",
        "su",
        "0",
        "cat",
        "/sys/module/vmw_vsock_virtio_transport_common/parameters/virtio_transport_max_vsock_pkt_buf_size",
      ]);
      if (packetLimit !== String(vsockPacketBytes)) {
        throw new Error("emulator-vsock-limit-mismatch");
      }
      process.stdout.write(
        `Android release validation: ${role} VSOCK packet limit ${packetLimit}\n`,
      );
      phase("emulators");
      await deviceCommand(device, [
        "shell",
        "settings",
        "put",
        "global",
        "window_animation_scale",
        "0",
      ]);
      await deviceCommand(device, [
        "shell",
        "settings",
        "put",
        "global",
        "transition_animation_scale",
        "0",
      ]);
      await deviceCommand(device, [
        "shell",
        "settings",
        "put",
        "global",
        "animator_duration_scale",
        "0",
      ]);
      // Match screenshot automation: a fresh Wear display can sleep while the phone is onboarding.
      await deviceCommand(device, ["shell", "svc", "power", "stayon", "true"]);
      await deviceCommand(device, ["install", "-t", "-g", role === "phone" ? phoneApk : wearApk]);
      await deviceCommand(device, ["install", "-t", "-g", role === "phone" ? phoneTest : wearTest]);
      device.forward = Number(
        await deviceCommand(device, ["forward", "tcp:0", `localabstract:openclaw-release-${role}`]),
      );
      if (!Number.isInteger(device.forward) || device.forward <= 0) {
        throw new Error("forward-port-missing");
      }
    }
    const phone = devices.find((d) => d.role === "phone")!;
    const wear = devices.find((d) => d.role === "wear")!;
    await deviceCommand(phone, [
      "reverse",
      "localabstract:openclaw-release-peer",
      `tcp:${wear.forward}`,
    ]);
    await deviceCommand(wear, [
      "reverse",
      "localabstract:openclaw-release-peer",
      `tcp:${phone.forward}`,
    ]);
    await deviceCommand(phone, ["reverse", `tcp:${instance.port}`, `tcp:${instance.port}`]);
    evidence.emulators = {
      fresh: true,
      phone: `android-36/google_apis/${abi}`,
      wear: `android-34/android-wear/${abi}`,
      vsockPacketBytes,
      // Metadata must use the same headless backend as the CI emulators.
      sdkEmulator: await command(path.join(sdk, "emulator/emulator"), ["-no-window", "-version"]),
    };
    const setup = await rpc<{ setupCode: string }>("device.pair.setupCode", {
      publicUrl: instance.url,
      includeQr: false,
    });
    if (!setup.setupCode?.trim()) {
      throw new Error("missing-setup-code");
    }
    async function control(device: Device, operation: "health" | "continue" | "finish") {
      const response = await fetch(`http://127.0.0.1:${device.forward}/${operation}`, {
        method: operation === "health" ? "GET" : "POST",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) {
        throw new Error("transport-control-failed");
      }
      return operation === "health" ? response.json() : undefined;
    }
    await deviceCommand(phone, ["shell", "run-as", applicationId, "mkdir", "-p", "files"]);
    await command(
      adb,
      [
        "-s",
        phone.serial,
        "shell",
        `run-as ${applicationId} sh -c 'cat > files/release-setup-code'`,
      ],
      10_000,
      { input: setup.setupCode.trim() },
    );
    await deviceCommand(phone, [
      "shell",
      "run-as",
      applicationId,
      "chmod",
      "600",
      "files/release-setup-code",
    ]);
    async function instrument(device: Device, releasePhase: string) {
      phase(`${device.role}-${releasePhase}-launch`);
      await deviceCommand(device, ["shell", "input", "keyevent", "224"]);
      await deviceCommand(device, ["shell", "wm", "dismiss-keyguard"]);
      let text = "";
      let finished = false;
      let exitCode: number | undefined;
      const testClass =
        device.role === "phone"
          ? "ai.openclaw.app.AndroidReleasePhoneTest"
          : "ai.openclaw.wear.AndroidReleaseWearTest";
      const args = [
        "-s",
        device.serial,
        "shell",
        "am",
        "instrument",
        "-w",
        "-r",
        "-e",
        "class",
        `${testClass}#releasePhase`,
        "-e",
        "releasePhase",
        releasePhase,
      ];
      args.push(
        "-e",
        "screenshots",
        "1",
        `${applicationId}.test/androidx.test.runner.AndroidJUnitRunner`,
      );
      const stop = new AbortController();
      const index = ++commandIndex;
      const done = runManagedCommand({
        bin: adb,
        args,
        cwd: repo,
        env,
        signal: AbortSignal.any([abort.signal, stop.signal]),
        timeoutMs: 900_000,
        shell: false,
        requireProcessTreeExit: true,
        stdio: ["ignore", "pipe", "pipe"],
        onReady(child) {
          for (const stream of [child.stdout, child.stderr]) {
            stream?.on("data", (chunk: Buffer) => {
              text = (text + chunk.toString()).slice(-16 * 1024 * 1024);
            });
          }
        },
      })
        .then((code) => {
          exitCode = code;
          finished = true;
          if (
            code !== 0 ||
            !/OK \(1 test\)/u.test(text) ||
            /FAILURES!!!|INSTRUMENTATION_FAILED/u.test(text)
          ) {
            diagnostic("native", {
              role: device.role,
              phase: releasePhase,
              exitCode,
              ...androidReleaseNativeFacts(text),
            });
            throw new Error("native-test-failed");
          }
        })
        .then(
          async () => {
            await writeFile(path.join(root, `instrumentation-${index}.private.log`), text);
          },
          async (error: unknown) => {
            await writeFile(path.join(root, `instrumentation-${index}.private.log`), text);
            throw error;
          },
        );
      void done.catch(() => {});
      services.push({ stop, done });
      return {
        async ready(name: string) {
          phase(`${device.role}-${name}`);
          await poll(async () => {
            if (
              finished ||
              /FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_STATUS_CODE: -(?:2|3|4)/u.test(
                text,
              )
            ) {
              diagnostic("native", {
                role: device.role,
                phase: releasePhase,
                exitCode,
                ...androidReleaseNativeFacts(text),
              });
              throw new Error("native-test-failed");
            }
            return text.includes(`OPENCLAW_ANDROID_PHASE_READY ${name}`) ? true : undefined;
          }, 240_000);
          evidence.phases.push(`${device.role}:${name}`);
          transports.push(
            androidReleaseTransportSnapshot(await control(device, "health"), device.role, name),
          );
          phase(`${device.role}-${name}-screenshots`);
          await deviceCommand(device, [
            "pull",
            `/sdcard/Android/data/${applicationId}/files/release-validation/.`,
            path.join(artifactsDir, "screenshots"),
          ]);
        },
        async finish() {
          await control(device, "finish");
          await done;
        },
      };
    }
    const firstPhone = await instrument(phone, "initial");
    await firstPhone.ready("initial");
    phase("phone-setup-cleanup");
    await deviceCommand(phone, [
      "shell",
      "run-as",
      applicationId,
      "rm",
      "files/release-setup-code",
    ]);
    const firstWear = await instrument(wear, "initial");
    await firstWear.ready("initial");
    await firstWear.finish();
    await deviceCommand(wear, ["shell", "am", "force-stop", applicationId]);
    const restartedWear = await instrument(wear, "relaunch");
    await restartedWear.ready("relaunch");
    await firstPhone.finish();
    await deviceCommand(phone, ["shell", "am", "force-stop", applicationId]);
    const restartedPhone = await instrument(phone, "relaunch");
    await restartedPhone.ready("relaunch");
    await control(wear, "continue");
    await restartedWear.ready("phone-restart");
    await configureProvider(true);
    await control(wear, "continue");
    await restartedWear.ready("long-reply");
    await control(phone, "continue");
    await restartedPhone.ready("reader");
    await restartedWear.finish();
    await restartedPhone.finish();
    requireAndroidReleaseTransportEvidence(transports);
    evidence.transport = transports;
    phase("provider-evidence");
    evidence.provider = androidReleaseProviderEvidence(await readFile(requestLog, "utf8"));
    if (unexpectedExit) {
      throw new Error("fixture-exited");
    }
    if (
      (await command("git", ["rev-parse", "HEAD"])) !== evidence.targetSha ||
      JSON.stringify(await androidReleaseSourceEvidence(command, repo)) !==
        JSON.stringify(evidence.source)
    ) {
      throw new Error("source-changed-during-validation");
    }
    evidence.status = "passed";
  } catch (error) {
    evidence.failure = stage;
    diagnostic("runner", androidReleaseErrorFacts(error));
    if (hasUnjoinedWork(error)) {
      preserveRoot = true;
    }
    await writeFile(
      path.join(root, "failure.private.log"),
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    for (const device of devices) {
      // Failure screens can include a setup credential. Keep them private, outside
      // the published screenshot directory, and collect before emulator teardown.
      try {
        const health = await fetch(`http://127.0.0.1:${device.forward}/health`, {
          signal: AbortSignal.timeout(5_000),
        }).then((response) => response.json());
        await writeFile(
          path.join(root, `${device.role}-transport.private.json`),
          JSON.stringify(health),
        );
      } catch {
        /* The test may already have closed its endpoint. */
      }
      {
        const captureNames =
          device.role === "wear"
            ? ["wear-initial", "wear-relaunch", "wear-type-before", "wear-type-after"]
            : ["phone-reader-before", "phone-reader"];
        for (const captureName of captureNames) {
          try {
            const facts = await command(
              adb,
              [
                "-s",
                device.serial,
                "exec-out",
                "run-as",
                applicationId,
                "cat",
                `files/release-validation-failure/${captureName}.json`,
              ],
              10_000,
              { cleanup: true },
            );
            JSON.parse(facts);
            await writeFile(path.join(root, `${captureName}.private.json`), facts);
            await command(
              adb,
              [
                "-s",
                device.serial,
                "exec-out",
                "run-as",
                applicationId,
                "cat",
                `files/release-validation-failure/${captureName}.png`,
              ],
              10_000,
              { cleanup: true, binaryFile: path.join(root, `${captureName}.private.png`) },
            );
          } catch {
            /* Only the failing phase has an app-private capture. */
          }
        }
      }
      try {
        await deviceCommand(
          device,
          ["shell", "screencap", "-p", "/sdcard/release-failure.png"],
          10_000,
          true,
        );
        await deviceCommand(
          device,
          [
            "pull",
            "/sdcard/release-failure.png",
            path.join(root, `${device.role}-failure.private.png`),
          ],
          10_000,
          true,
        );
        await deviceCommand(
          device,
          ["logcat", "-d", "-t", "200", "-s", "AndroidRuntime"],
          10_000,
          true,
        );
      } catch {
        /* Teardown still joins the owning processes below. */
      }
    }
    process.stderr.write(
      `Android release validation failed at ${stage}; private diagnostics: ${root}\n`,
    );
  } finally {
    closing = true;
    // Disconnect releases ADB's device forwards too. Remove live routes before stopping
    // only the emulator process trees launched by this invocation.
    for (const device of devices) {
      try {
        const forwards = await command(adb, ["forward", "--list"], 10_000, { cleanup: true });
        if (
          device.forward &&
          forwards
            .split("\n")
            .some((line) => line.startsWith(`${device.serial} tcp:${device.forward} `))
        ) {
          await deviceCommand(
            device,
            ["forward", "--remove", `tcp:${device.forward}`],
            10_000,
            true,
          );
        }
      } catch {
        preserveRoot = true;
      }
    }
    for (const child of services) {
      child.stop.abort();
    }
    const gatewayCleanup = await Promise.allSettled([instance?.cleanup()]);
    const cleanup = await Promise.allSettled(services.map((child) => child.done));
    const cleanupFailed =
      gatewayCleanup.some((entry) => entry.status === "rejected") ||
      cleanup.some((entry) => entry.status === "rejected" && hasUnjoinedWork(entry.reason));
    evidence.cleanupConfirmed = !cleanupFailed && !preserveRoot;
    if (!evidence.cleanupConfirmed) {
      evidence.status = "failed";
    }
    if (instance) {
      await writeFile(path.join(root, "gateway.private.log"), instance.logs());
    }
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    if (evidence.status === "passed" && evidence.cleanupConfirmed) {
      await rm(root, { recursive: true, force: true });
    } else {
      process.exitCode = 1;
    }
  }
  process.stdout.write(`Android release validation ${evidence.status}: ${output}\n`);
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error("Android release validation preparation failed.");
    process.exitCode = 1;
  });
}
