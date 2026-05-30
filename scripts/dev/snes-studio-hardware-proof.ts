import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildSnesPreviewRom,
  createDefaultSnesStudioProject,
  createSnesEmulatorBootProof,
  createSnesEmulatorScreenshotComparison,
  createSnesFxpakCopyDryRun,
  createSnesFxpakCopyProof,
  createSnesFxpakExportPackage,
  createSnesHardwareQaBundle,
  createSnesSramImage,
  createSnesSramPowerCycleProof,
  selectSnesFxpakMountedVolume,
  writeSnesSaveSlot,
  type SnesEmulatorBootExecution,
  type SnesEmulatorKind,
  type SnesFxpakMountedVolumeProbe,
  type SnesStudioProject,
} from "../../packages/snes-studio-core/src/index.ts";

type FileExists = (path: string) => boolean;
type ProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout?: number },
) => SpawnSyncReturns<Buffer>;

export type SnesHardwareProofRunOptions = {
  afterSramPath?: string | null;
  artifactDir: string;
  availableEmulators?: SnesEmulatorKind[];
  copyFxpak?: boolean;
  detectedVolumes?: SnesFxpakMountedVolumeProbe[];
  emulatorExecutables?: Partial<Record<SnesEmulatorKind, string>>;
  emulatorTimeoutMs?: number;
  expectedScreenshotChecksum?: number | null;
  expectedScreenshotPath?: string | null;
  now?: string;
  project?: SnesStudioProject;
  runEmulator?: boolean;
  runner?: ProcessRunner;
};

export type SnesHardwareProofRunSummary = {
  ok: boolean;
  ci: {
    conclusion: "complete" | "artifact-ready";
    completeHardwareRequired: boolean;
    note: string;
  };
  artifactDir: string;
  generatedAt: string;
  projectName: string;
  rom: {
    fileName: string;
    path: string;
    sizeBytes: number;
    sha256: string;
  };
  emulator: {
    detected: SnesEmulatorKind[];
    executables: Partial<Record<SnesEmulatorKind, string>>;
    selectedExecutable: string | null;
    status: ReturnType<typeof createSnesEmulatorBootProof>["status"];
    proofPath: string;
    screenshotComparisonPath: string;
    blocker: string | null;
  };
  fxpak: {
    status: "ready" | "blocked";
    selectedVolume: string | null;
    dryRunPath: string;
    copyProofPath: string;
    copiedRomPath: string | null;
    blocker: string | null;
  };
  sram: {
    beforePath: string;
    afterPath: string | null;
    status: ReturnType<typeof createSnesSramPowerCycleProof>["status"];
    proofPath: string;
    blocker: string | null;
  };
  hardwareQaBundlePath: string;
  blockers: string[];
};

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function pathEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PATH ?? "").split(delimiter).filter(Boolean);
}

function emulatorExecutableCandidates(name: SnesEmulatorKind, env: NodeJS.ProcessEnv): string[] {
  const fromPath = pathEntries(env).map((entry) => join(entry, name));
  if (platform() !== "darwin") {
    return fromPath;
  }
  const appName =
    name === "mesen" ? "Mesen" : name === "snes9x" ? "Snes9x" : name === "bsnes" ? "bsnes" : "ares";
  const homeApplications = env.HOME ? join(env.HOME, "Applications") : null;
  return [
    ...fromPath,
    ...(homeApplications
      ? [
          join(homeApplications, `${appName}.app`, "Contents", "MacOS", appName),
          join(homeApplications, `${name}.app`, "Contents", "MacOS", name),
        ]
      : []),
    `/Applications/${appName}.app/Contents/MacOS/${appName}`,
    `/Applications/${name}.app/Contents/MacOS/${name}`,
  ];
}

export function detectSnesEmulators(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: FileExists = existsSync,
): SnesEmulatorKind[] {
  return (
    Object.keys(detectSnesEmulatorExecutables(env, fileExists)) as SnesEmulatorKind[]
  ).toSorted();
}

export function detectSnesEmulatorExecutables(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: FileExists = existsSync,
): Partial<Record<SnesEmulatorKind, string>> {
  const detected: Partial<Record<SnesEmulatorKind, string>> = {};
  for (const name of ["ares", "bsnes", "mesen", "snes9x"] as const) {
    const executable = emulatorExecutableCandidates(name, env).find((candidate) =>
      fileExists(candidate),
    );
    if (executable) {
      detected[name] = executable;
    }
  }
  return detected;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fxpakProbeFromEnv(env: NodeJS.ProcessEnv): SnesFxpakMountedVolumeProbe | null {
  const volumePath = env.OPENCLAW_SNES_STUDIO_FXPAK_VOLUME?.trim();
  if (!volumePath) {
    return null;
  }
  const fileSystem = (env.OPENCLAW_SNES_STUDIO_FXPAK_FS?.trim() || "unknown").toUpperCase();
  return {
    cardSizeGb: numberFromEnv(env.OPENCLAW_SNES_STUDIO_FXPAK_CARD_GB, 0),
    existingSavePresent: env.OPENCLAW_SNES_STUDIO_FXPAK_EXISTING_SAVE === "1",
    fileSystem:
      fileSystem === "FAT32" || fileSystem === "APFS" || fileSystem === "HFS+"
        ? fileSystem
        : fileSystem === "EXFAT"
          ? "exFAT"
          : "unknown",
    freeBytes: numberFromEnv(env.OPENCLAW_SNES_STUDIO_FXPAK_FREE_BYTES, 0),
    mounted: existsSync(volumePath),
    volumePath,
  };
}

export function detectSnesFxpakVolumes(
  env: NodeJS.ProcessEnv = process.env,
  root = "/Volumes",
  fileExists: FileExists = existsSync,
): SnesFxpakMountedVolumeProbe[] {
  const explicit = fxpakProbeFromEnv(env);
  if (explicit) {
    return [explicit];
  }
  if (!fileExists(root)) {
    return [];
  }
  const likelyPattern = /(?:fxpak|sd2snes|sd2-snes|sdcard|snes\s*sd|everdrive)/iu;
  return readdirSync(root)
    .filter((entry) => likelyPattern.test(entry))
    .map((entry) => ({
      cardSizeGb: 0,
      existingSavePresent: false,
      fileSystem: "unknown" as const,
      freeBytes: 0,
      mounted: true,
      volumePath: join(root, entry),
    }));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checksum16(bytes: Uint8Array): number {
  let sum = 0;
  for (const byte of bytes) {
    sum = (sum + byte) & 0xffff;
  }
  return sum;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function safeReadBytes(path: string | null | undefined): Uint8Array | null {
  if (!path || !existsSync(path)) {
    return null;
  }
  return readFileSync(path);
}

function executeEmulatorIfRequested(
  runEmulator: boolean,
  command: string[],
  artifactDir: string,
  emulatorExecutables: Partial<Record<SnesEmulatorKind, string>>,
  runner: ProcessRunner,
  timeoutMs: number,
): SnesEmulatorBootExecution | null {
  if (!runEmulator || command.length === 0) {
    return null;
  }
  const [binary, ...args] = command;
  const executable = emulatorExecutables[binary as SnesEmulatorKind] ?? binary;
  const startedAt = Date.now();
  const result = runner(executable, args, { cwd: artifactDir, timeout: timeoutMs });
  const elapsedMs = Date.now() - startedAt;
  const screenshotFileName = command.find((part) => part.endsWith(".png")) ?? "";
  const screenshotPath = screenshotFileName ? join(artifactDir, screenshotFileName) : "";
  const timedOut = result.error?.message?.toLowerCase().includes("timed out") ?? false;
  return {
    elapsedMs,
    exitCode: result.status ?? 1,
    screenshotBytes: safeReadBytes(screenshotPath) ?? new Uint8Array(),
    stderr: timedOut
      ? `Emulator command timed out after ${timeoutMs}ms.`
      : (result.stderr?.toString("utf8") ?? ""),
    stdout: result.stdout?.toString("utf8") ?? "",
  };
}

function ensureParentDirectory(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function createCiHardwareProofSummary(blockers: string[]): SnesHardwareProofRunSummary["ci"] {
  if (blockers.length === 0) {
    return {
      conclusion: "complete",
      completeHardwareRequired: true,
      note: "Full emulator, screenshot, FXPAK copy, and SRAM power-cycle proof completed.",
    };
  }
  return {
    conclusion: "artifact-ready",
    completeHardwareRequired: false,
    note: "Hardware proof artifacts were generated. Missing emulator execution, FXPAK card, or SRAM after-image evidence is reported as explicit non-blocking readiness state unless --require-complete is used.",
  };
}

export function runSnesHardwareProof(
  options: SnesHardwareProofRunOptions,
): SnesHardwareProofRunSummary {
  const artifactDir = resolve(options.artifactDir || join(".artifacts", "snes-hardware-proof"));
  mkdirSync(artifactDir, { recursive: true });
  const generatedAt = options.now ?? new Date().toISOString();
  const project = options.project ?? createDefaultSnesStudioProject(generatedAt);
  const rom = buildSnesPreviewRom(project);
  const romPath = join(artifactDir, rom.fileName);
  writeFileSync(romPath, rom.bytes);

  const emulatorExecutables = options.emulatorExecutables ?? detectSnesEmulatorExecutables();
  const detectedEmulators =
    options.availableEmulators ?? (Object.keys(emulatorExecutables) as SnesEmulatorKind[]);
  const runner = options.runner ?? spawnSync;
  const initialBootProof = createSnesEmulatorBootProof(rom, detectedEmulators);
  const emulatorExecution = executeEmulatorIfRequested(
    options.runEmulator === true,
    initialBootProof.plan.command,
    artifactDir,
    emulatorExecutables,
    runner,
    options.emulatorTimeoutMs ?? 15000,
  );
  const bootProof = createSnesEmulatorBootProof(rom, detectedEmulators, emulatorExecution);
  const expectedScreenshotChecksum =
    options.expectedScreenshotChecksum ??
    (options.expectedScreenshotPath
      ? checksum16(readFileSync(options.expectedScreenshotPath))
      : null);
  const screenshotComparison = createSnesEmulatorScreenshotComparison(
    rom,
    emulatorExecution?.screenshotBytes ?? null,
    {
      expectedChecksum: expectedScreenshotChecksum,
      screenshotFileName: initialBootProof.plan.screenshotFileName,
    },
  );
  const emulatorProofPath = join(
    artifactDir,
    `${rom.fileName.replace(/\.sfc$/i, "")}.emulator-proof.json`,
  );
  const screenshotComparisonPath = join(
    artifactDir,
    `${rom.fileName.replace(/\.sfc$/i, "")}.screenshot-comparison.json`,
  );
  writeJson(emulatorProofPath, bootProof);
  writeJson(screenshotComparisonPath, screenshotComparison);

  const fxpakPackage = createSnesFxpakExportPackage(rom);
  const detectedVolumes = options.detectedVolumes ?? detectSnesFxpakVolumes();
  const volumeSelection = selectSnesFxpakMountedVolume(fxpakPackage, detectedVolumes);
  const selectedVolume = volumeSelection.selectedVolume;
  const dryRun = selectedVolume ? createSnesFxpakCopyDryRun(fxpakPackage, selectedVolume) : null;
  const dryRunPath = join(artifactDir, `${rom.fileName.replace(/\.sfc$/i, "")}.fxpak-dry-run.json`);
  writeJson(dryRunPath, dryRun ?? volumeSelection);

  let copiedRomPath: string | null = null;
  let copyProof = createSnesFxpakCopyProof(fxpakPackage, rom.bytes, null);
  if (options.copyFxpak === true && selectedVolume && dryRun?.status === "ready") {
    const romOperation = dryRun.operations.find((operation) => operation.kind === "rom");
    if (romOperation) {
      ensureParentDirectory(romOperation.destinationPath);
      writeFileSync(romOperation.destinationPath, rom.bytes);
      copiedRomPath = romOperation.destinationPath;
      copyProof = createSnesFxpakCopyProof(
        fxpakPackage,
        rom.bytes,
        readFileSync(romOperation.destinationPath),
        romOperation.destinationPath,
      );
    }
  }
  const copyProofPath = join(
    artifactDir,
    `${rom.fileName.replace(/\.sfc$/i, "")}.fxpak-copy-proof.json`,
  );
  writeJson(copyProofPath, copyProof);

  const beforeSram = writeSnesSaveSlot(project, createSnesSramImage(project), 0, {
    bosscleared: true,
    checkpoint: 1,
    coins: 1,
  });
  const beforeSramPath = join(artifactDir, `${rom.fileName.replace(/\.sfc$/i, "")}.before.srm`);
  writeFileSync(beforeSramPath, beforeSram);
  const afterSram = safeReadBytes(options.afterSramPath);
  const sramProof = createSnesSramPowerCycleProof(project, beforeSram, afterSram, 0);
  const sramProofPath = join(artifactDir, `${rom.fileName.replace(/\.sfc$/i, "")}.sram-proof.json`);
  writeJson(sramProofPath, sramProof);

  const hardwareQaBundle = createSnesHardwareQaBundle(project, generatedAt, {
    availableEmulators: detectedEmulators,
    emulatorExecution,
    mountedVolume: selectedVolume,
    sramPowerCycle: sramProof,
  });
  const hardwareQaBundlePath = join(
    artifactDir,
    `${rom.fileName.replace(/\.sfc$/i, "")}.hardware-qa.json`,
  );
  writeJson(hardwareQaBundlePath, hardwareQaBundle);

  const blockers = [
    ...(bootProof.status === "verified" ? [] : bootProof.blockers),
    ...(screenshotComparison.status === "verified" ? [] : screenshotComparison.blockers),
    ...(dryRun?.status === "ready" ? [] : volumeSelection.blockers),
    ...(copyProof.status === "verified"
      ? []
      : options.copyFxpak
        ? copyProof.blockers
        : ["FXPAK copy command was not requested; no real card copy proof was produced."]),
    ...(sramProof.status === "verified" ? [] : sramProof.blockers),
  ];

  const summary: SnesHardwareProofRunSummary = {
    ok: blockers.length === 0,
    ci: createCiHardwareProofSummary([...new Set(blockers)]),
    artifactDir,
    generatedAt,
    projectName: project.name,
    rom: {
      fileName: rom.fileName,
      path: romPath,
      sizeBytes: statSync(romPath).size,
      sha256: sha256(rom.bytes),
    },
    emulator: {
      detected: detectedEmulators,
      executables: emulatorExecutables,
      selectedExecutable:
        initialBootProof.plan.selectedEmulator === null
          ? null
          : (emulatorExecutables[initialBootProof.plan.selectedEmulator] ??
            initialBootProof.plan.selectedEmulator),
      status: bootProof.status,
      proofPath: emulatorProofPath,
      screenshotComparisonPath,
      blocker: bootProof.status === "verified" ? null : (bootProof.blockers[0] ?? null),
    },
    fxpak: {
      status: dryRun?.status ?? "blocked",
      selectedVolume: selectedVolume?.volumePath ?? null,
      dryRunPath,
      copyProofPath,
      copiedRomPath,
      blocker:
        dryRun?.status === "ready"
          ? copyProof.status === "verified"
            ? null
            : options.copyFxpak
              ? (copyProof.blockers[0] ?? null)
              : "FXPAK copy command was not requested; dry-run only."
          : (volumeSelection.blockers[0] ?? null),
    },
    sram: {
      beforePath: beforeSramPath,
      afterPath: options.afterSramPath ?? null,
      status: sramProof.status,
      proofPath: sramProofPath,
      blocker: sramProof.status === "verified" ? null : (sramProof.blockers[0] ?? null),
    },
    hardwareQaBundlePath,
    blockers: [...new Set(blockers)],
  };
  writeJson(join(artifactDir, "summary.json"), summary);
  return summary;
}

function readArgValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function parseCliVolume(args: string[]): SnesFxpakMountedVolumeProbe[] | undefined {
  const volumePath = readArgValue(args, "--fxpak-volume");
  if (!volumePath) {
    return undefined;
  }
  const fileSystem = (readArgValue(args, "--fxpak-fs") ?? "unknown").toUpperCase();
  return [
    {
      cardSizeGb: Number(readArgValue(args, "--fxpak-card-gb") ?? 0),
      existingSavePresent: args.includes("--fxpak-existing-save"),
      fileSystem:
        fileSystem === "FAT32" || fileSystem === "APFS" || fileSystem === "HFS+"
          ? fileSystem
          : fileSystem === "EXFAT"
            ? "exFAT"
            : "unknown",
      freeBytes: Number(readArgValue(args, "--fxpak-free-bytes") ?? 0),
      mounted: existsSync(volumePath),
      volumePath,
    },
  ];
}

function cliMain() {
  const args = process.argv.slice(2);
  const artifactDir =
    readArgValue(args, "--artifact-dir") ??
    join(".artifacts", "snes-hardware-proof", timestampSlug());
  const summary = runSnesHardwareProof({
    afterSramPath: readArgValue(args, "--after-sram"),
    artifactDir,
    copyFxpak: args.includes("--copy-fxpak"),
    detectedVolumes: parseCliVolume(args),
    emulatorTimeoutMs: Number(readArgValue(args, "--emulator-timeout-ms") ?? 15000),
    expectedScreenshotChecksum:
      readArgValue(args, "--expected-screenshot-checksum") === null
        ? null
        : Number(readArgValue(args, "--expected-screenshot-checksum")),
    expectedScreenshotPath: readArgValue(args, "--expected-screenshot"),
    runEmulator: args.includes("--run-emulator"),
  });
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.ok || !args.includes("--require-complete") ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cliMain();
}
