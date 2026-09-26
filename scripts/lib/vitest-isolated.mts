import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePnpmRunner } from "../pnpm-runner.mts";
import { hasUnjoinedWork, runManagedCommand, signalExitCode } from "./managed-child-process.mts";
import { isRecord } from "./record-shared.mjs";
import {
  collectVitestFileFilters,
  resolveExplicitVitestMode,
  vitestOptionConsumesNextArg,
} from "./vitest-cli-mode.mts";
import {
  copyIsolatedVitestSource,
  isIsolatedSourcePath,
  prepareIsolatedVitestDependencies,
  type IsolatedVitestMount,
} from "./vitest-isolated-source.mts";

const LABEL = "io.openclaw.vitest-isolated";
const CONTAINER_ENV = {
  PATH: "/opt/openclaw-vitest:/usr/local/bin:/usr/bin:/bin",
  HOME: "/tmp/home",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  CI: "1",
  // Native pools otherwise see the host CPU count and can exhaust the PID budget.
  RAYON_NUM_THREADS: "4",
  TOKIO_WORKER_THREADS: "4",
  // Rolldown owns a custom Tokio pool and does not use TOKIO_WORKER_THREADS.
  ROLLDOWN_WORKER_THREADS: "4",
  GOMAXPROCS: "4",
  PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  COREPACK_ENABLE_NETWORK: "0",
  npm_config_manage_package_manager_versions: "false",
  container: "podman",
};

export function parseIsolatedVitestArgs(argv: string[]) {
  let image: string | undefined;
  const args: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") {
      args.push(...argv.slice(index));
      break;
    }
    if (arg === "--isolated-image" || arg.startsWith("--isolated-image=")) {
      if (image !== undefined) {
        throw new Error("--isolated-image must occur once.");
      }
      image = arg === "--isolated-image" ? argv[++index] : arg.slice("--isolated-image=".length);
      if (
        !image ||
        !/^(?:(?:sha256:)?[a-f0-9]{64}|[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64})$/u.test(image)
      ) {
        throw new Error(
          "--isolated-image requires a full local sha256 image ID or repository@sha256 digest; tags are refused.",
        );
      }
    } else {
      args.push(arg);
      if (vitestOptionConsumesNextArg(arg, argv[index + 1])) {
        args.push(argv[++index]!);
      }
    }
  }
  return image === undefined ? null : { image, args };
}

/** Keep the first supported surface finite and source-qualified, not an alternate CLI. */
export function admitIsolatedVitestArgs(argv: string[], copied: ReadonlySet<string>) {
  if (resolveExplicitVitestMode(argv) !== "run" || argv.includes("--")) {
    throw new Error("Isolated Vitest requires explicit run mode without a separator tail.");
  }
  const files = collectVitestFileFilters(argv);
  if (files.length === 0) {
    throw new Error("Isolated Vitest requires explicit tracked test files.");
  }
  for (const file of files) {
    if (
      !isIsolatedSourcePath(file) ||
      !/\.(?:test|e2e)\.[cm]?[jt]sx?$/u.test(file) ||
      !copied.has(file)
    ) {
      throw new Error(
        `Isolated test target must be an existing tracked relative test file (stage new files first): ${file}`,
      );
    }
  }
  const values = new Set([
    "--config",
    "--configLoader",
    "-c",
    "--maxWorkers",
    "--maxConcurrency",
    "--testNamePattern",
    "-t",
    "--testTimeout",
    "--hookTimeout",
    "--bail",
    "--reporter",
    "--pool",
    "--sequence.seed",
  ]);
  const booleans = new Set([
    "--run",
    "--no-file-parallelism",
    "--fileParallelism",
    "--no-fileParallelism",
    "--disableConsoleIntercept",
    "--silent",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("-")) {
      continue;
    }
    const equals = arg.indexOf("=");
    const key = equals < 0 ? arg : arg.slice(0, equals);
    if (!values.has(key) && !booleans.has(key)) {
      throw new Error(`Unsupported isolated Vitest option: ${key}`);
    }
    const value =
      equals < 0 ? (values.has(key) ? argv[++index] : undefined) : arg.slice(equals + 1);
    if (values.has(key) && (!value || value.startsWith("-"))) {
      throw new Error(`Missing value for ${key}`);
    }
    if (
      (key === "--config" || key === "-c") &&
      (!value || !copied.has(value) || !isIsolatedSourcePath(value))
    ) {
      throw new Error("Isolated config must be a tracked relative source file.");
    }
    if (key === "--configLoader" && value !== "runner") {
      throw new Error("Isolated Vitest requires the runner config loader.");
    }
    if (
      key === "--reporter" &&
      !["default", "verbose", "dot", "basic", "tap", "tap-flat"].includes(value ?? "")
    ) {
      throw new Error("Isolation supports built-in console reporters only.");
    }
  }
}

export function isolatedVitestCreateArgs(options: {
  name: string;
  image: string;
  snapshot: string;
  mounts: IsolatedVitestMount[];
  node: string;
  pnpm: string;
  uid: number;
  gid: number;
  pnpmVersion: string;
  argv: string[];
}) {
  const { name, image, snapshot, mounts, node, pnpm, uid, gid, pnpmVersion, argv } = options;
  const bindings = [
    { source: snapshot, target: "/workspace", readonly: false },
    ...mounts.map((mount) => ({ source: mount.source, target: mount.target, readonly: true })),
    { source: node, target: "/opt/openclaw-vitest/node", readonly: true },
    { source: pnpm, target: "/opt/openclaw-vitest/pnpm", readonly: true },
  ];
  for (const mount of bindings) {
    if (!path.isAbsolute(mount.source) || /[,\r\n\0]/u.test(mount.source)) {
      throw new Error("Unsupported bind path.");
    }
  }
  return [
    "create",
    "--name",
    name,
    "--label",
    `${LABEL}=${name}`,
    "--pull=never",
    "--network=none",
    "--http-proxy=false",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--read-only-tmpfs=false",
    "--userns=keep-id",
    `--user=${uid}:${gid}`,
    "--pid=private",
    // Tests can orphan descendants intentionally. Node cannot reap them as PID 1,
    // so retain the engine init that makes process-group extinction observable.
    "--init",
    "--ipc=private",
    "--cpus=4",
    "--memory=8g",
    "--memory-swap=8g",
    "--pids-limit=512",
    "--shm-size=512m",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=2g,mode=1777",
    "--tmpfs",
    "/run:rw,nosuid,nodev,noexec,size=16m",
    "--image-volume=ignore",
    "--unsetenv-all",
    "--log-driver=none",
    "--timeout=7200",
    "--stop-timeout=5",
    "--workdir=/workspace",
    ...Object.entries(CONTAINER_ENV).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ...bindings.flatMap((mount) => [
      "--mount",
      `type=bind,src=${mount.source},dst=${mount.target},${mount.readonly ? "ro" : "rw"}`,
    ]),
    "--entrypoint=/opt/openclaw-vitest/node",
    image,
    "scripts/lib/vitest-isolated-entry.mts",
    process.version,
    pnpmVersion,
    ...argv,
  ];
}

type CommandResult = { code: number; stdout: string };
export type IsolatedPodmanCommand = (
  args: string[],
  options?: { stream?: boolean; cleanup?: boolean },
) => Promise<CommandResult>;
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Invalid Podman inspection result.");
  }
  return value;
}
function inspection(stdout: string) {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Expected one Podman object.");
  }
  return record(parsed[0]);
}
async function checked(command: IsolatedPodmanCommand, args: string[], cleanup = false) {
  const result = await command(args, { cleanup });
  if (result.code !== 0) {
    throw new Error(`podman ${args[0]} failed (exit ${result.code}).`);
  }
  return result.stdout;
}

export function verifyIsolatedVitestHost(value: unknown): void {
  const security = record(value);
  if (security.rootless !== true) {
    throw new Error("Podman did not confirm rootless operation.");
  }
  if (security.selinuxEnabled !== false) {
    throw new Error(
      "Isolated Vitest does not yet support SELinux-labeled hosts. It will not relabel shared dependencies or disable host enforcement; use a supported isolated runner.",
    );
  }
}

export function verifyIsolatedVitestContainer(
  value: Record<string, unknown>,
  name: string,
  expectedMounts: string[],
) {
  const config = record(value.Config);
  if (record(config.Labels)[LABEL] !== name) {
    throw new Error("Container ownership label mismatch; refusing to start/remove it.");
  }
  const host = record(value.HostConfig);
  if (
    host.NetworkMode !== "none" ||
    host.Privileged !== false ||
    host.ReadonlyRootfs !== true ||
    host.Init !== true ||
    config.User !== `${process.getuid?.()}:${process.getgid?.()}`
  ) {
    throw new Error("Container isolation settings differ from the admitted invocation.");
  }
  const expectedEnv = new Set(Object.entries(CONTAINER_ENV).map(([key, val]) => `${key}=${val}`));
  if (
    !Array.isArray(config.Env) ||
    config.Env.length !== expectedEnv.size ||
    config.Env.some((entry: unknown) => typeof entry !== "string" || !expectedEnv.has(entry))
  ) {
    throw new Error("Container inherited unexpected environment variables.");
  }
  if (!Array.isArray(value.Mounts)) {
    throw new Error("Missing container mount inspection.");
  }
  const actual = value.Mounts.map((mount: unknown) => {
    const entry = record(mount);
    if (
      entry.Type !== "bind" ||
      typeof entry.Source !== "string" ||
      typeof entry.Destination !== "string" ||
      typeof entry.RW !== "boolean"
    ) {
      throw new Error("Unexpected image/default container volume.");
    }
    return `${entry.Source}:${entry.Destination}:${entry.RW ? "rw" : "ro"}`;
  }).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expectedMounts.toSorted())) {
    throw new Error("Container has unexpected host/default mounts.");
  }
}

/** A successful return includes positive absence after removal, not merely CLI exit. */
export async function runIsolatedVitestContainer(options: {
  command: IsolatedPodmanCommand;
  name: string;
  createArgs: string[];
  verify: (value: Record<string, unknown>) => void;
  onAbsent: () => void;
}) {
  const { command, name, createArgs, verify, onAbsent } = options;
  const exists = await command(["container", "exists", name]);
  if (exists.code !== 1) {
    throw new Error("Cannot establish an unused isolated container name.");
  }
  let outcome: number | undefined;
  let failure: Error | undefined;
  try {
    await checked(command, createArgs);
    verify(inspection(await checked(command, ["container", "inspect", name])));
    const attached = await command(["start", "--attach", name], { stream: true });
    const state = record(inspection(await checked(command, ["container", "inspect", name])).State);
    if (state.Running !== false) {
      throw new Error("Container did not stop with the attached invocation.");
    }
    const waited = Number((await checked(command, ["wait", name])).trim());
    if (
      !Number.isInteger(waited) ||
      waited < 0 ||
      waited > 255 ||
      state.ExitCode !== waited ||
      attached.code !== waited
    ) {
      throw new Error("Container/attach/wait exit receipts disagree.");
    }
    outcome = waited;
  } catch (error) {
    failure =
      error instanceof Error
        ? error
        : new Error("Isolated container invocation failed.", { cause: error });
  }
  try {
    // A failed create/start is not proof that no container was created. Reconcile
    // only this invocation's random name and label, including after interruption.
    const present = await command(["container", "exists", name], { cleanup: true });
    if (present.code === 0) {
      const value = inspection(await checked(command, ["container", "inspect", name], true));
      if (record(record(value.Config).Labels)[LABEL] !== name) {
        throw new Error("Uncertain container ownership; cleanup refused.");
      }
      const state = record(value.State);
      if (state.Running === true) {
        await checked(command, ["stop", "--time", "5", name], true);
      }
      if (state.Status !== "created" && state.Status !== "configured") {
        await checked(command, ["wait", name], true);
      }
      await checked(command, ["rm", "--force", "--time", "5", name], true);
      const absent = await command(["container", "exists", name], { cleanup: true });
      if (absent.code !== 1) {
        throw new Error(`Container cleanup is uncertain: ${name}`);
      }
    } else if (present.code !== 1) {
      throw new Error(`Container cleanup is uncertain: ${name}`);
    }
    // Container absence does not join a failed host Podman process: it may still
    // consume the snapshot or finish creating the container after this observation.
    if (!hasUnjoinedWork(failure)) {
      onAbsent();
    }
  } catch (error) {
    throw new AggregateError(
      failure === undefined ? [error] : [failure, error],
      "Isolated container cleanup failed; retain the snapshot.",
      { cause: error },
    );
  }
  if (failure !== undefined) {
    throw failure;
  }
  return outcome ?? 1;
}

function nativeExecutable(file: string): string {
  const real = fs.realpathSync(file);
  const fd = fs.openSync(real, "r");
  try {
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error(
        "Isolation currently requires prepared native Linux Node and pnpm executables (no Corepack/download shim).",
      );
    }
  } finally {
    fs.closeSync(fd);
  }
  return real;
}

export async function runIsolatedVitest(
  root: string,
  image: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
) {
  if (
    process.platform !== "linux" ||
    !process.getuid ||
    !process.getgid ||
    process.getuid() === 0
  ) {
    throw new Error("Isolated Vitest requires Linux and a non-root user with rootless Podman.");
  }
  if (fs.realpathSync(process.cwd()) !== root) {
    throw new Error("Run isolated Vitest from the repository root.");
  }
  if (!env.HOME || !path.isAbsolute(env.HOME)) {
    throw new Error("Rootless Podman requires an explicit host HOME for its client storage.");
  }
  // Podman may inject subscription mounts at start, after create-time inspection.
  // This narrow adapter refuses that host facility rather than editing its policy.
  for (const file of [
    "/usr/share/containers/mounts.conf",
    "/etc/containers/mounts.conf",
    path.join(env.HOME, ".config/containers/mounts.conf"),
  ]) {
    if (
      fs.existsSync(file) &&
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .some((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    ) {
      throw new Error(`Isolated Vitest does not support automatic host mounts from ${file}.`);
    }
  }
  const runner = resolvePnpmRunner({ env });
  if (runner.args.length || !path.isAbsolute(runner.command)) {
    throw new Error("Put the pinned native pnpm executable on PATH before isolation.");
  }
  const pnpm = nativeExecutable(runner.command);
  const node = nativeExecutable(process.execPath);
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, onSignal);
  }
  // This is the Podman/Git client's environment, NOT the container's. No remote
  // engine selector, proxy, loader, credential, or arbitrary host environment.
  const hostEnv = {
    PATH: "/usr/bin:/bin",
    HOME: env.HOME,
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
    LANG: "C.UTF-8",
  };
  const invoke = async (
    bin: string,
    args: string[],
    options: { stream?: boolean; cleanup?: boolean } = {},
  ) => {
    if (interrupted && !options.cleanup) {
      throw new Error("Isolated invocation interrupted.");
    }
    let stdout = "";
    const code = await runManagedCommand({
      bin,
      args,
      cwd: root,
      env: hostEnv,
      stdio: options.stream ? "inherit" : ["ignore", "pipe", "inherit"],
      timeoutMs: options.stream ? 7_210_000 : 30_000,
      requireProcessTreeExit: true,
      onSignal,
      onReady(child) {
        if (options.stream) {
          return;
        }
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
      },
    });
    return { code, stdout };
  };
  const command: IsolatedPodmanCommand = (args, options) =>
    invoke("podman", ["--remote=false", ...args], options);
  let temporary: string | undefined;
  let safeToRemove = true;
  try {
    verifyIsolatedVitestHost(
      JSON.parse(await checked(command, ["info", "--format", "{{json .Host.Security}}"])),
    );
    const inspectedImage = inspection(await checked(command, ["image", "inspect", image]));
    const imageId = inspectedImage.Id;
    if (typeof imageId !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(imageId)) {
      throw new Error("Invalid immutable local image ID.");
    }
    const config = record(inspectedImage.Config);
    console.error(
      `[vitest:isolated] image sha256:${imageId.replace(/^sha256:/u, "")} (image environment and entrypoint overridden)`,
    );
    if (config.Env !== undefined && !Array.isArray(config.Env)) {
      throw new Error("Invalid image environment metadata.");
    }
    const listed = await invoke("git", ["ls-files", "--cached", "-z"]);
    if (listed.code !== 0) {
      throw new Error("Cannot enumerate tracked working-tree source.");
    }
    const tracked = listed.stdout.split("\0").filter(Boolean);
    const base = path.join(root, ".openclaw", "tmp");
    fs.mkdirSync(base, { recursive: true });
    if (fs.realpathSync(base) !== base) {
      throw new Error("Isolated scratch root has symlinked ancestors.");
    }
    temporary = fs.mkdtempSync(path.join(base, "vitest-isolated-"));
    const snapshot = path.join(temporary, "source");
    fs.mkdirSync(snapshot);
    const source = copyIsolatedVitestSource(root, snapshot, tracked);
    admitIsolatedVitestArgs(argv, source.copied);
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(snapshot, "package.json"), "utf8"),
    );
    const pin = record(manifest).packageManager;
    const pnpmVersion =
      typeof pin === "string" ? /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)/u.exec(pin)?.[1] : undefined;
    if (!pnpmVersion) {
      throw new Error("Missing pinned pnpm packageManager.");
    }
    if (!source.copied.has("scripts/lib/vitest-isolated-entry.mts")) {
      throw new Error("Stage the isolated adapter's new source files before running it.");
    }
    const mounts = prepareIsolatedVitestDependencies(root, snapshot, source.copied);
    const name = `openclaw-vitest-${randomUUID()}`;
    console.error(
      `[vitest:isolated] source sha256:${source.digest}; ${source.copied.size} working-tree files; network=none; container=${name}`,
    );
    const createArgs = isolatedVitestCreateArgs({
      name,
      image: imageId,
      snapshot,
      mounts,
      node,
      pnpm,
      uid: process.getuid(),
      gid: process.getgid(),
      pnpmVersion,
      argv,
    });
    const expectedMounts = [
      `${snapshot}:/workspace:rw`,
      ...mounts.map((mount) => `${mount.source}:${mount.target}:ro`),
      `${node}:/opt/openclaw-vitest/node:ro`,
      `${pnpm}:/opt/openclaw-vitest/pnpm:ro`,
    ];
    safeToRemove = false;
    const code = await runIsolatedVitestContainer({
      command,
      name,
      createArgs,
      verify: (value) => verifyIsolatedVitestContainer(value, name, expectedMounts),
      onAbsent: () => {
        safeToRemove = true;
      },
    });
    console.error(`[vitest:isolated] exit=${code}; container absence confirmed`);
    return interrupted ? signalExitCode(interrupted) : code;
  } catch (error) {
    if (hasUnjoinedWork(error)) {
      safeToRemove = false;
    }
    if (interrupted && safeToRemove) {
      return signalExitCode(interrupted);
    }
    throw error;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.off(signal, onSignal);
    }
    if (temporary && safeToRemove) {
      fs.rmSync(temporary, { recursive: true, force: true });
    } else if (temporary) {
      console.error(`[vitest:isolated] cleanup uncertain; retained ${temporary}; no host fallback`);
    }
  }
}
