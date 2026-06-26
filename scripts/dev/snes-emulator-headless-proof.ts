import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Runner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => SpawnSyncReturns<Buffer>;

export type SnesHeadlessEmulatorAdapter = {
  id: "ares" | "bsnes" | "mesen" | "snes9x" | string;
  executablePath: string;
  command: (input: { frames: number; romPath: string; screenshotPath: string }) => {
    args: string[];
    command: string;
  };
};

export type SnesHeadlessEmulatorAttempt = {
  adapterId: string;
  blocker: string | null;
  command: string[];
  error: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  screenshotPath: string;
  screenshotSha256: string | null;
  status: "pass" | "blocked";
  stderr: string;
  stdout: string;
};

export type SnesHeadlessEmulatorProofReceipt = {
  attempts: SnesHeadlessEmulatorAttempt[];
  blocker: string | null;
  emulator: string | null;
  format: "openclaw-snes-emulator-headless-proof-v1";
  generatedAt: string;
  proofSurface: ["emulator-launch", "emulator-screenshot", "runtime-signature"];
  proofTier: "headless-emulator-adapter";
  projectSpecific: false;
  rom: {
    path: string;
    sha256: string;
    sizeBytes: number;
  } | null;
  runtimeSignature: {
    expectedRomSha256: string | null;
    pass: boolean;
  };
  screenshot: {
    path: string | null;
    sha256: string | null;
    sizeBytes: number;
  };
  status: "pass" | "blocked";
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function pathEntries() {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean);
}

function firstExisting(candidates: string[]) {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function commandOnPath(names: string[]) {
  return firstExisting(names.flatMap((name) => pathEntries().map((entry) => join(entry, name))));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function detectHeadlessEmulatorAdapters(): SnesHeadlessEmulatorAdapter[] {
  const adapters: SnesHeadlessEmulatorAdapter[] = [];
  const snes9x =
    commandOnPath(["snes9x", "Snes9x"]) ||
    firstExisting([
      "/Applications/Snes9x.app/Contents/MacOS/Snes9x",
      "/Applications/SNES9x.app/Contents/MacOS/SNES9x",
      `${process.env.HOME ?? ""}/Applications/Snes9x.app/Contents/MacOS/Snes9x`,
    ]);
  if (snes9x) {
    adapters.push({
      id: "snes9x",
      executablePath: snes9x,
      command: ({ romPath, screenshotPath }) => ({
        args: ["-snapshot", screenshotPath, romPath],
        command: snes9x,
      }),
    });
  }
  const ares = commandOnPath(["ares"]);
  if (ares) {
    const scrot = commandOnPath(["scrot"]);
    const xvfb = commandOnPath(["Xvfb"]);
    if (scrot && xvfb) {
      adapters.push({
        id: "ares-x11-scrot",
        executablePath: ares,
        command: ({ frames, romPath, screenshotPath }) => {
          const display = `:${90 + Math.max(0, Math.min(9, frames % 10))}`;
          const waitSeconds = String(Math.max(4, Math.min(20, Math.ceil(frames / 60))));
          const script = [
            "set -euo pipefail",
            `${shellQuote(xvfb)} ${shellQuote(display)} -screen 0 1280x1024x24 -nolisten tcp -ac &`,
            "XVFB_PID=$!",
            "cleanup() { kill \"$ARES_PID\" >/dev/null 2>&1 || true; kill \"$XVFB_PID\" >/dev/null 2>&1 || true; }",
            "trap cleanup EXIT",
            "sleep 1",
            `DISPLAY=${shellQuote(display)} ${shellQuote(ares)} ${shellQuote(romPath)} &`,
            "ARES_PID=$!",
            `sleep ${shellQuote(waitSeconds)}`,
            `DISPLAY=${shellQuote(display)} ${shellQuote(scrot)} ${shellQuote(screenshotPath)}`,
          ].join("\n");
          return {
            args: ["-lc", script],
            command: "/bin/bash",
          };
        },
      });
    }
    adapters.push({
      id: "ares",
      executablePath: ares,
      command: ({ romPath, screenshotPath }) => ({
        args: ["--fullscreen=false", "--screenshot", screenshotPath, romPath],
        command: ares,
      }),
    });
  }
  const bsnes = commandOnPath(["bsnes"]);
  if (bsnes) {
    adapters.push({
      id: "bsnes",
      executablePath: bsnes,
      command: ({ romPath, screenshotPath }) => ({
        args: [romPath, "--screenshot", screenshotPath],
        command: bsnes,
      }),
    });
  }
  const mesen =
    commandOnPath(["mesen", "mesen2", "Mesen"]) ||
    firstExisting([
      "/Applications/Mesen.app/Contents/MacOS/Mesen",
      "/Applications/MesenCE.app/Contents/MacOS/Mesen",
      `${process.env.HOME ?? ""}/.openclaw/snes-toolchain/mesen/Mesen.app/Contents/MacOS/Mesen`,
    ]);
  if (mesen) {
    adapters.push({
      id: "mesen",
      executablePath: mesen,
      command: ({ romPath, screenshotPath }) => ({
        args: [romPath, "--screenshot", screenshotPath],
        command: mesen,
      }),
    });
  }
  return adapters;
}

function isNonblankPng(path: string): { ok: boolean; blocker: string | null } {
  const bytes = readFileSync(path);
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const hasPngSignature = pngSignature.every((byte, index) => bytes[index] === byte);
  if (!hasPngSignature) {
    return { ok: false, blocker: "Screenshot is not a PNG file." };
  }
  if (bytes.length < 32) {
    return { ok: false, blocker: "Screenshot PNG is too small to be useful proof." };
  }
  const unique = new Set(bytes).size;
  const nonZero = bytes.reduce((count, byte) => count + (byte === 0 ? 0 : 1), 0);
  if (unique <= 1 || nonZero === 0) {
    return { ok: false, blocker: "Screenshot PNG appears blank or uninitialized." };
  }
  return { ok: true, blocker: null };
}

function normalizeOutput(value: Buffer | null | undefined) {
  return value?.toString("utf8").slice(0, 4000) ?? "";
}

function runAdapter(input: {
  adapter: SnesHeadlessEmulatorAdapter;
  artifactDir: string;
  frames: number;
  romPath: string;
  runner: Runner;
  timeoutMs: number;
}): SnesHeadlessEmulatorAttempt {
  const screenshotPath = join(input.artifactDir, `${input.adapter.id}.boot.png`);
  rmSync(screenshotPath, { force: true });
  const command = input.adapter.command({
    frames: input.frames,
    romPath: input.romPath,
    screenshotPath,
  });
  const result = input.runner(command.command, command.args, {
    cwd: input.artifactDir,
    timeout: input.timeoutMs,
  });
  const failureDetail =
    result.status === null
      ? (result.signal ?? result.error?.message ?? "unknown")
      : String(result.status);
  if ((result.status ?? 1) !== 0) {
    return {
      adapterId: input.adapter.id,
      blocker: `Emulator exited with status ${failureDetail}.`,
      command: [command.command, ...command.args],
      error: result.error?.message ?? null,
      exitCode: result.status,
      signal: result.signal,
      screenshotPath,
      screenshotSha256: null,
      status: "blocked",
      stderr: normalizeOutput(result.stderr),
      stdout: normalizeOutput(result.stdout),
    };
  }
  if (!existsSync(screenshotPath)) {
    return {
      adapterId: input.adapter.id,
      blocker: "Emulator exited cleanly but did not create a screenshot.",
      command: [command.command, ...command.args],
      error: result.error?.message ?? null,
      exitCode: result.status,
      signal: result.signal,
      screenshotPath,
      screenshotSha256: null,
      status: "blocked",
      stderr: normalizeOutput(result.stderr),
      stdout: normalizeOutput(result.stdout),
    };
  }
  const png = isNonblankPng(screenshotPath);
  if (!png.ok) {
    return {
      adapterId: input.adapter.id,
      blocker: png.blocker,
      command: [command.command, ...command.args],
      error: result.error?.message ?? null,
      exitCode: result.status,
      signal: result.signal,
      screenshotPath,
      screenshotSha256: sha256File(screenshotPath),
      status: "blocked",
      stderr: normalizeOutput(result.stderr),
      stdout: normalizeOutput(result.stdout),
    };
  }
  return {
    adapterId: input.adapter.id,
    blocker: null,
    command: [command.command, ...command.args],
    error: result.error?.message ?? null,
    exitCode: result.status,
    signal: result.signal,
    screenshotPath,
    screenshotSha256: sha256File(screenshotPath),
    status: "pass",
    stderr: normalizeOutput(result.stderr),
    stdout: normalizeOutput(result.stdout),
  };
}

export function runHeadlessEmulatorProof(input: {
  adapters?: SnesHeadlessEmulatorAdapter[];
  artifactDir: string;
  expectedRomSha256?: string | null;
  frames?: number;
  now?: string;
  romPath: string;
  runner?: Runner;
  timeoutMs?: number;
}): SnesHeadlessEmulatorProofReceipt {
  const generatedAt = input.now ?? new Date().toISOString();
  const artifactDir = resolve(input.artifactDir);
  mkdirSync(artifactDir, { recursive: true });
  const romPath = resolve(input.romPath);
  const proofSurface: ["emulator-launch", "emulator-screenshot", "runtime-signature"] = [
    "emulator-launch",
    "emulator-screenshot",
    "runtime-signature",
  ];
  if (!existsSync(romPath)) {
    return {
      attempts: [],
      blocker: `ROM file is missing: ${romPath}`,
      emulator: null,
      format: "openclaw-snes-emulator-headless-proof-v1",
      generatedAt,
      proofSurface,
      proofTier: "headless-emulator-adapter",
      projectSpecific: false,
      rom: null,
      runtimeSignature: { expectedRomSha256: input.expectedRomSha256 ?? null, pass: false },
      screenshot: { path: null, sha256: null, sizeBytes: 0 },
      status: "blocked",
    };
  }
  const romSha256 = sha256File(romPath);
  const expectedRomSha256 = input.expectedRomSha256 ?? romSha256;
  if (expectedRomSha256 !== romSha256) {
    return {
      attempts: [],
      blocker: `ROM SHA mismatch: expected ${expectedRomSha256}, actual ${romSha256}.`,
      emulator: null,
      format: "openclaw-snes-emulator-headless-proof-v1",
      generatedAt,
      proofSurface,
      proofTier: "headless-emulator-adapter",
      projectSpecific: false,
      rom: { path: romPath, sha256: romSha256, sizeBytes: statSync(romPath).size },
      runtimeSignature: { expectedRomSha256, pass: false },
      screenshot: { path: null, sha256: null, sizeBytes: 0 },
      status: "blocked",
    };
  }
  const adapters = input.adapters ?? detectHeadlessEmulatorAdapters();
  const attempts: SnesHeadlessEmulatorAttempt[] = [];
  for (const adapter of adapters) {
    const attempt = runAdapter({
      adapter,
      artifactDir,
      frames: input.frames ?? 120,
      romPath,
      runner: input.runner ?? spawnSync,
      timeoutMs: input.timeoutMs ?? 20_000,
    });
    attempts.push(attempt);
    if (attempt.status === "pass") {
      return {
        attempts,
        blocker: null,
        emulator: adapter.id,
        format: "openclaw-snes-emulator-headless-proof-v1",
        generatedAt,
        proofSurface,
        proofTier: "headless-emulator-adapter",
        projectSpecific: false,
        rom: { path: romPath, sha256: romSha256, sizeBytes: statSync(romPath).size },
        runtimeSignature: { expectedRomSha256, pass: true },
        screenshot: {
          path: attempt.screenshotPath,
          sha256: attempt.screenshotSha256,
          sizeBytes: statSync(attempt.screenshotPath).size,
        },
        status: "pass",
      };
    }
  }
  return {
    attempts,
    blocker:
      adapters.length === 0
        ? "No headless emulator adapter candidates were detected."
        : "No emulator adapter produced verified screenshot/runtime proof.",
    emulator: null,
    format: "openclaw-snes-emulator-headless-proof-v1",
    generatedAt,
    proofSurface,
    proofTier: "headless-emulator-adapter",
    projectSpecific: false,
    rom: { path: romPath, sha256: romSha256, sizeBytes: statSync(romPath).size },
    runtimeSignature: { expectedRomSha256, pass: false },
    screenshot: { path: null, sha256: null, sizeBytes: 0 },
    status: "blocked",
  };
}

function parseArgs(argv: string[]) {
  const valueAfter = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    artifactDir: valueAfter("--artifact-dir") ?? join(".artifacts", "snes-emulator-headless-proof"),
    expectedRomSha256: valueAfter("--expected-rom-sha256"),
    frames: Number(valueAfter("--frames") ?? 120),
    json: argv.includes("--json"),
    romPath: valueAfter("--rom"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.romPath) {
    process.stderr.write("Missing required --rom <path>.\n");
    process.exit(2);
  }
  const receipt = runHeadlessEmulatorProof({
    artifactDir: args.artifactDir,
    expectedRomSha256: args.expectedRomSha256,
    frames: args.frames,
    romPath: args.romPath,
  });
  writeJson(join(args.artifactDir, "receipt.json"), receipt);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    process.stdout.write(
      `SNES emulator headless proof ${receipt.status}: ${receipt.blocker ?? receipt.emulator}\n`,
    );
  }
  process.exit(receipt.status === "pass" ? 0 : 2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
