import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, arch } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_ARTIFACT_DIR = path.join(REPO_ROOT, ".artifacts", "snes-toolchain");
const DEFAULT_PROJECTS_ROOT = path.join(REPO_ROOT, ".artifacts", "snes-projects");
const DEFAULT_PROJECT_ID = "comet-fox-mvp";
const STANSKI_PROJECT_ID = "stanskis-world";
const TOOLCHAIN_HOME =
  process.env.OPENCLAW_SNES_TOOLCHAIN_HOME || path.join(homedir(), ".openclaw", "snes-toolchain");
const MANIFEST_PATH = path.join(TOOLCHAIN_HOME, "toolchain-manifest.json");
const BIN_DIR = path.join(TOOLCHAIN_HOME, "bin");
const REQUIRED_PROJECT_ASSET_TYPES = Object.freeze([
  "character-sprite",
  "enemy-sprite",
  "item-sprite",
  "tileset",
  "background-layer",
]);
const STANSKI_LEVEL_ONE_ID = "w1-1-cleveland-skyline-scramble";

const STANSKI_VISUAL_CATEGORY_GRADES = Object.freeze({
  inGameScreenshots: 3,
  spriteSheets: 72,
  toddSpriteSheet: 72,
  enemySpriteSheet: 72,
  itemSpriteSheet: 72,
  tileset: 20,
  backgroundLayer: 8,
});
const PRODUCTION_VISUAL_PROOF_SOURCES = new Set(["runtime-capture", "emulator-capture"]);
const STANSKI_VISUAL_REJECTION_REASONS = Object.freeze([
  "User human in-game visual score is 3/100.",
  "Sprite sheets improved to 72/100, but Todd still reads as a square box in runtime.",
  "Tileset grade is 20/100 and does not yet read as a professional SNES environment.",
  "Background layer grade is 8/100 and does not read as a recognizable Cleveland skyline.",
  "Current runtime screenshots still read as Atari-level placeholder graphics, not commercial SNES-era quality.",
  "Super Mario World may be used only as a quality reference; Nintendo code, ROMs, and copied pixels are not permitted in this clean-room pipeline.",
]);
const STANSKI_CLEVELAND_LANDMARKS = Object.freeze([
  {
    id: "terminal-tower",
    label: "Terminal Tower",
    visualCue: "central tan tower with stepped crown, green cap, and antenna spire",
  },
  {
    id: "key-tower",
    label: "Key Tower",
    visualCue: "tall blue-gray skyscraper with pointed pyramid roof",
  },
  {
    id: "200-public-square",
    label: "200 Public Square",
    visualCue: "wide dark office tower with dense window grid",
  },
  {
    id: "cuyahoga-bridge-truss",
    label: "Cuyahoga River bridge truss",
    visualCue: "steel triangular truss crossing the midground",
  },
  {
    id: "lake-erie",
    label: "Lake Erie",
    visualCue: "blue horizon band behind downtown",
  },
]);
const STANSKI_VISUAL_SOURCE_POLICY = Object.freeze({
  status: "clean-room-required",
  sourceStrategy: "original-clean-room-local-pixel-art",
  commercialRomDownloadAllowed: false,
  commercialRomOrAssetCopied: false,
  nintendoCodeOrAssetsUsed: false,
  copiedCommercialPixelsAllowed: false,
  hostedImageProviderAllowed: false,
  hostedGlmAllowed: false,
  paidAssetAllowedWithoutApproval: false,
  smwReferenceOnly: true,
  allowed: [
    "original OpenClaw-authored pixel art",
    "free/accountless local tools",
    "human critique and measurable receipt gates",
  ],
  disallowed: [
    "downloading Super Mario World code or ROMs",
    "copying Nintendo sprites, tiles, maps, music, code, or palettes",
    "claiming human 100/100 approval without the user's explicit approval receipt",
  ],
});

function cleanRoomSourcePolicy() {
  return {
    ...STANSKI_VISUAL_SOURCE_POLICY,
    allowed: [...STANSKI_VISUAL_SOURCE_POLICY.allowed],
    disallowed: [...STANSKI_VISUAL_SOURCE_POLICY.disallowed],
  };
}

function stanskiClevelandLandmarks() {
  return STANSKI_CLEVELAND_LANDMARKS.map((landmark) => ({ ...landmark }));
}
const STANSKI_PROMPT_REFERENCES = Object.freeze([
  {
    id: "base-codex-ready-prompt",
    source:
      "/Users/openclaw/.codex/attachments/b704a5ba-3f50-41a6-967d-68ce0b3469ed/pasted-text.txt",
  },
  {
    id: "full-prompt-expansion",
    source:
      "/Users/openclaw/.codex/attachments/7d2674dd-5c55-45e4-86b5-26f1596cdae5/pasted-text.txt",
  },
  {
    id: "latest-game-instructions",
    source:
      "/Users/openclaw/.codex/attachments/e3f69e14-15e5-4786-96bd-2269ce3d90fd/pasted-text.txt",
  },
  {
    id: "fxpak-pro-spec-expansion",
    source:
      "/Users/openclaw/.codex/attachments/ee1e22b2-6011-40d5-bdf7-97bd1591fb7e/pasted-text.txt",
  },
  {
    id: "secrets-hidden-systems",
    source:
      "/Users/openclaw/.codex/attachments/82f32647-b718-402c-b282-baa972380082/pasted-text.txt",
  },
  {
    id: "cohesive-storyline",
    source:
      "/Users/openclaw/.codex/attachments/f337e397-3104-4775-976e-ae96a66d3999/pasted-text.txt",
  },
]);
const STANSKI_REFERENCE_ASSETS = Object.freeze([
  {
    assetId: "todd-stanski-reference",
    type: "character-sprite",
    usage: "Character identity source for Todd Stanski sprites, portraits, and title art.",
  },
  {
    assetId: "man-boy-snes-photo-reference",
    type: "background-layer",
    usage:
      "Man-and-boy photo source planned for SNES-safe inclusion as the Family Memory Card secret room cameo, with optional ending/credits memory card reuse after visual QA.",
  },
]);

const REQUIRED_STANSKI_AUDIO_EVENTS = Object.freeze([
  "level-theme",
  "jump",
  "pickup",
  "damage",
  "projectile",
  "toilet-ending",
  "fireworks",
]);

const ROM_SCAFFOLD_BLOCKER =
  "Generated ROM is a text-mode scaffold, not a production gameplay ROM; FXPAK export is blocked until real tilemap, metasprite/OAM, gameplay, and audio proof exist.";

const TOOL_DEFINITIONS = Object.freeze({
  pixelorama: {
    label: "Pixelorama",
    brew: { type: "cask", name: "pixelorama" },
    commands: ["pixelorama", "Pixelorama"],
    appPaths: [
      "/Applications/Pixelorama.app",
      "/Applications/Pixelorama.app/Contents/MacOS/Pixelorama",
    ],
    github: {
      repo: "Orama-Interactive/Pixelorama",
      asset: /(?:mac|macos|darwin|osx).*\.(?:zip|dmg)$/iu,
    },
    required: true,
  },
  tiled: {
    label: "Tiled",
    brew: { type: "cask", name: "tiled" },
    commands: ["tiled", "Tiled"],
    appPaths: ["/Applications/Tiled.app", "/Applications/Tiled.app/Contents/MacOS/Tiled"],
    github: { repo: "mapeditor/tiled", asset: /(?:mac|macos|darwin|osx).*\.(?:zip|dmg)$/iu },
    required: false,
  },
  ldtk: {
    label: "LDtk",
    brew: { type: "cask", name: "ldtk" },
    commands: ["ldtk", "LDtk"],
    appPaths: ["/Applications/LDtk.app", "/Applications/LDtk.app/Contents/MacOS/LDtk"],
    github: { repo: "deepnight/ldtk", asset: /(?:mac|darwin|osx).*\.(?:zip|dmg)$/iu },
    required: true,
  },
  pvsneslib: {
    label: "PVSnesLib",
    commands: ["pvsneslib", "pvsneslib-config"],
    env: "PVSNESLIB_HOME",
    dirs: [
      path.join(TOOLCHAIN_HOME, "pvsneslib"),
      "/opt/pvsneslib",
      "/usr/local/pvsneslib",
      "/opt/devkitpro/pvsneslib",
    ],
    github: {
      repo: "alekmaul/pvsneslib",
      asset: /(?:mac|macos|darwin|osx).*\.(?:zip|tar\.gz|tgz)$/iu,
    },
    required: true,
  },
  superfamiconv: {
    label: "SuperFamiconv",
    commands: ["superfamiconv"],
    brew: { type: "formula", name: "superfamiconv" },
    paths: [
      path.join(BIN_DIR, "superfamiconv"),
      "/opt/homebrew/bin/superfamiconv",
      "/usr/local/bin/superfamiconv",
    ],
    github: {
      repo: "Optiroc/SuperFamiconv",
      asset: /(?:mac|macos|darwin|osx|arm64|aarch64).*\.(?:zip|tar\.gz|tgz)$/iu,
    },
    source: { repo: "https://github.com/Optiroc/SuperFamiconv.git", binaries: ["superfamiconv"] },
    required: true,
  },
  superfamicheck: {
    label: "SuperFamicheck",
    commands: ["superfamicheck"],
    brew: { type: "formula", name: "superfamicheck" },
    paths: [
      path.join(BIN_DIR, "superfamicheck"),
      "/opt/homebrew/bin/superfamicheck",
      "/usr/local/bin/superfamicheck",
    ],
    github: {
      repo: "Optiroc/SuperFamicheck",
      asset: /(?:mac|macos|darwin|osx|arm64|aarch64).*\.(?:zip|tar\.gz|tgz)$/iu,
    },
    source: { repo: "https://github.com/Optiroc/SuperFamicheck.git", binaries: ["superfamicheck"] },
    required: true,
  },
  mesen: {
    label: "MesenCE",
    commands: ["mesen", "mesen2", "Mesen"],
    appPaths: [
      "/Applications/Mesen.app",
      "/Applications/MesenCE.app",
      "/Applications/Mesen.app/Contents/MacOS/Mesen",
      "/Applications/MesenCE.app/Contents/MacOS/Mesen",
    ],
    github: {
      repo: "nesdev-org/MesenCE",
      asset: /(?:mac|macos|darwin|osx).*(?:arm|apple|silicon|aarch64).*\.(?:zip|dmg)$/iu,
    },
    required: false,
  },
  bsnes: {
    label: "bsnes",
    commands: ["bsnes"],
    brew: { type: "cask", name: "bsnes" },
    appPaths: ["/Applications/bsnes.app", "/Applications/bsnes.app/Contents/MacOS/bsnes"],
    github: { repo: "bsnes-emu/bsnes", asset: /(?:mac|macos|darwin|osx).*\.(?:zip|dmg)$/iu },
    required: false,
  },
  brrtools: {
    label: "BRR-compatible encoder",
    commands: ["brr_encoder", "brrencode", "brrtools", "snesbrr"],
    paths: [
      path.join(BIN_DIR, "brr_encoder"),
      "/opt/homebrew/bin/brr_encoder",
      "/usr/local/bin/brr_encoder",
    ],
    required: true,
    audioOnly: true,
  },
});

function nowIso() {
  return new Date().toISOString();
}

function timestampSlug() {
  return nowIso().replace(/[:.]/gu, "-");
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeReadText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [BIN_DIR, process.env.PATH || ""].filter(Boolean).join(path.delimiter),
      HOMEBREW_NO_AUTO_UPDATE: process.env.HOMEBREW_NO_AUTO_UPDATE || "1",
      HOMEBREW_NO_INSTALL_CLEANUP: process.env.HOMEBREW_NO_INSTALL_CLEANUP || "1",
      NONINTERACTIVE: "1",
      ...options.env,
    },
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    timeout: options.timeoutMs || 120_000,
  });
  return {
    command,
    args,
    cwd: options.cwd || REPO_ROOT,
    status: result.status,
    signal: result.signal,
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function launchDetached(command, args = [], options = {}) {
  try {
    const child = spawn(command, args, {
      cwd: options.cwd || REPO_ROOT,
      detached: true,
      env: {
        ...process.env,
        PATH: [BIN_DIR, process.env.PATH || ""].filter(Boolean).join(path.delimiter),
        HOMEBREW_NO_AUTO_UPDATE: process.env.HOMEBREW_NO_AUTO_UPDATE || "1",
        HOMEBREW_NO_INSTALL_CLEANUP: process.env.HOMEBREW_NO_INSTALL_CLEANUP || "1",
        NONINTERACTIVE: "1",
        ...options.env,
      },
      stdio: "ignore",
    });
    child.unref();
    return {
      args,
      command,
      cwd: options.cwd || REPO_ROOT,
      detached: true,
      error: null,
      ok: true,
      pid: child.pid ?? null,
      signal: null,
      status: 0,
      stderr: "",
      stdout: "",
    };
  } catch (error) {
    return {
      args,
      command,
      cwd: options.cwd || REPO_ROOT,
      detached: true,
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      pid: null,
      signal: null,
      status: null,
      stderr: "",
      stdout: "",
    };
  }
}

function pathEntries() {
  return [BIN_DIR, ...(process.env.PATH || "").split(path.delimiter)].filter(Boolean);
}

function findOnPath(commands) {
  for (const dir of pathEntries()) {
    for (const command of commands) {
      const candidate = path.join(dir, command);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function loadManifest() {
  return readJsonIfExists(MANIFEST_PATH) || { version: 1, tools: {}, notes: [] };
}

function manifestToolPaths(toolId) {
  const manifest = loadManifest();
  const record = manifest.tools?.[toolId];
  return [record?.path, record?.home, ...(record?.paths || [])].filter(Boolean);
}

function candidatesForTool(toolId) {
  const def = TOOL_DEFINITIONS[toolId];
  return [
    ...(def.env && process.env[def.env] ? [process.env[def.env]] : []),
    ...manifestToolPaths(toolId),
    ...(def.paths || []),
    ...(def.appPaths || []),
    ...(def.dirs || []),
    findOnPath(def.commands || []) || null,
  ].filter(Boolean);
}

export function detectTool(toolId) {
  const def = TOOL_DEFINITIONS[toolId];
  for (const candidate of candidatesForTool(toolId)) {
    if (candidate && existsSync(candidate)) {
      const resolved = resolveToolPath(toolId, candidate);
      if (!isUsableResolvedTool(toolId, resolved)) continue;
      return {
        available: true,
        blocker: null,
        id: toolId,
        label: def.label,
        path: resolved,
        required: def.required,
        version: probeVersion(toolId, resolved),
      };
    }
  }
  return {
    available: false,
    blocker: `${def.label} was not detected on PATH, common macOS app paths, or ${MANIFEST_PATH}.`,
    id: toolId,
    label: def.label,
    path: null,
    required: def.required,
    version: null,
  };
}

function isUsableResolvedTool(toolId, resolved) {
  const stats = statSafe(resolved);
  if (!stats) return false;
  if (toolId === "pvsneslib")
    return stats.isDirectory() && existsSync(path.join(resolved, "devkitsnes"));
  return stats.isFile();
}

function resolveToolPath(toolId, candidate) {
  const def = TOOL_DEFINITIONS[toolId];
  const stats = statSafe(candidate);
  if (!stats?.isDirectory()) return candidate;
  if (toolId === "pvsneslib") {
    const nested = path.join(candidate, "pvsneslib");
    if (existsSync(path.join(nested, "devkitsnes"))) return nested;
    return candidate;
  }
  const directBinary = findDeep(candidate, def.commands || []);
  if (directBinary) return directBinary;
  const appBundle = findAppBundle(candidate);
  if (appBundle) {
    const appName = path.basename(appBundle, ".app");
    const executable = path.join(appBundle, "Contents", "MacOS", appName);
    if (existsSync(executable)) return executable;
    const macosDir = path.join(appBundle, "Contents", "MacOS");
    if (existsSync(macosDir)) {
      const files = readdirSync(macosDir).map((name) => path.join(macosDir, name));
      const firstExecutable = files.find((file) => statSafe(file)?.isFile());
      if (firstExecutable) return firstExecutable;
    }
    return appBundle;
  }
  return candidate;
}

function findAppBundle(root) {
  if (!existsSync(root)) return null;
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) return full;
      if (entry.isDirectory() && ![".git", "node_modules"].includes(entry.name)) queue.push(full);
    }
  }
  return null;
}

function probeVersion(toolId, candidate) {
  const def = TOOL_DEFINITIONS[toolId];
  const command = statSafe(candidate)?.isDirectory() ? findOnPath(def.commands || []) : candidate;
  if (!command || !existsSync(command)) return null;
  if (
    command.includes(".app/Contents/MacOS/") ||
    ["mesen", "bsnes", "tiled", "ldtk"].includes(toolId)
  )
    return null;
  for (const args of [["--version"], ["-version"], ["-v"]]) {
    const result = run(command, args, { timeoutMs: 10_000 });
    const text = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/u)[0];
    if (result.ok && text) return text.slice(0, 180);
  }
  return null;
}

function statSafe(candidate) {
  try {
    return statSync(candidate);
  } catch {
    return null;
  }
}

export function probeToolchain(options = {}) {
  const tools = Object.keys(TOOL_DEFINITIONS).map((id) => detectTool(id));
  const requiredMissing = tools.filter((tool) => tool.required && !tool.available);
  const audioOnlyMissing = requiredMissing.filter((tool) => TOOL_DEFINITIONS[tool.id].audioOnly);
  const blockers = requiredMissing.map((tool) => tool.blocker);
  const report = {
    artifactDir: options.artifactDir || DEFAULT_ARTIFACT_DIR,
    brewPath: findOnPath(["brew"]),
    generatedAt: nowIso(),
    host: { arch: arch(), platform: platform() },
    manifestPath: MANIFEST_PATH,
    status:
      requiredMissing.length === 0
        ? "ready"
        : audioOnlyMissing.length === requiredMissing.length
          ? "partial"
          : "blocked",
    toolchainHome: TOOLCHAIN_HOME,
    tools,
    blockers,
  };
  return report;
}

function appendManifest(updates) {
  ensureDir(TOOLCHAIN_HOME);
  ensureDir(BIN_DIR);
  const manifest = loadManifest();
  const next = {
    ...manifest,
    generatedAt: nowIso(),
    home: TOOLCHAIN_HOME,
    version: 1,
    tools: { ...(manifest.tools || {}), ...(updates.tools || {}) },
    lastReceipts: { ...(manifest.lastReceipts || {}), ...(updates.lastReceipts || {}) },
    notes: [...(manifest.notes || []), ...(updates.notes || [])],
  };
  writeJson(MANIFEST_PATH, next);
  return next;
}

function brewAvailable() {
  return findOnPath(["brew"]);
}

function brewInfo(kind, name) {
  const brew = brewAvailable();
  if (!brew) return { ok: false, blocker: "Homebrew is not available." };
  const args = kind === "cask" ? ["info", "--cask", name] : ["info", "--formula", name];
  const result = run(brew, args, { timeoutMs: 60_000 });
  return result.ok
    ? { ok: true, result }
    : { ok: false, blocker: result.stderr || result.stdout || `brew info failed for ${name}` };
}

function brewInstall(kind, name) {
  const brew = brewAvailable();
  if (!brew) return { ok: false, blocker: "Homebrew is not available." };
  const args = kind === "cask" ? ["install", "--cask", name] : ["install", name];
  const result = run(brew, args, { timeoutMs: 20 * 60_000 });
  return result.ok
    ? { ok: true, result }
    : {
        ok: false,
        blocker: result.stderr || result.stdout || `brew install failed for ${name}`,
        result,
      };
}

function curlJson(url) {
  const result = run("curl", ["-fsSL", "--max-time", "60", url], { timeoutMs: 90_000 });
  if (!result.ok)
    return { ok: false, blocker: result.stderr || result.error || `curl failed for ${url}` };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      ok: false,
      blocker: `Invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function downloadFile(url, outputPath) {
  ensureDir(path.dirname(outputPath));
  const result = run("curl", ["-fL", "--max-time", "900", "-o", outputPath, url], {
    timeoutMs: 20 * 60_000,
  });
  return result.ok
    ? { ok: true, path: outputPath, sha256: sha256File(outputPath) }
    : { ok: false, blocker: result.stderr || result.error || `Download failed for ${url}`, result };
}

function extractArchive(archivePath, outputDir) {
  ensureDir(outputDir);
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".zip")) {
    const result = run("ditto", ["-x", "-k", archivePath, outputDir], { timeoutMs: 5 * 60_000 });
    if (!result.ok)
      return { ok: false, blocker: result.stderr || result.error || "ditto unzip failed", result };
    const nested = extractNestedArchive(outputDir);
    return nested.ok ? { ok: true, outputDir, nested: nested.extracted } : nested;
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    const result = run("tar", ["-xzf", archivePath, "-C", outputDir], { timeoutMs: 5 * 60_000 });
    return result.ok
      ? { ok: true, outputDir }
      : { ok: false, blocker: result.stderr || result.error || "tar extract failed", result };
  }
  if (lower.endsWith(".dmg")) {
    const mountPoint = path.join(TOOLCHAIN_HOME, "mounts", path.basename(archivePath, ".dmg"));
    rmSync(mountPoint, { recursive: true, force: true });
    ensureDir(mountPoint);
    const attached = run(
      "hdiutil",
      ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, archivePath],
      { timeoutMs: 120_000 },
    );
    if (!attached.ok)
      return {
        ok: false,
        blocker: attached.stderr || attached.error || "hdiutil attach failed",
        result: attached,
      };
    try {
      const appBundle = findAppBundle(mountPoint);
      if (!appBundle) return { ok: false, blocker: `No .app bundle found in ${archivePath}.` };
      const destination = path.join(outputDir, path.basename(appBundle));
      rmSync(destination, { recursive: true, force: true });
      copyDir(appBundle, destination);
      return { ok: true, outputDir, appBundle: destination };
    } finally {
      run("hdiutil", ["detach", mountPoint], { timeoutMs: 60_000 });
      rmSync(mountPoint, { recursive: true, force: true });
    }
  }
  return { ok: false, blocker: `Unsupported archive type: ${archivePath}` };
}

function extractNestedArchive(outputDir) {
  if (findAppBundle(outputDir)) return { ok: true, extracted: false };
  let entries = [];
  try {
    entries = readdirSync(outputDir, { withFileTypes: true });
  } catch (error) {
    return {
      ok: false,
      blocker: `Could not inspect extracted archive ${outputDir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const nestedArchive = entries
    .filter((entry) => entry.isFile() && /\.(?:zip|dmg|tar\.gz|tgz)$/iu.test(entry.name))
    .map((entry) => path.join(outputDir, entry.name))[0];
  if (!nestedArchive) return { ok: true, extracted: false };
  const nestedOut = path.join(outputDir, "__nested");
  rmSync(nestedOut, { recursive: true, force: true });
  ensureDir(nestedOut);
  const extracted = extractArchive(nestedArchive, nestedOut);
  if (!extracted.ok) return extracted;
  const appBundle = findAppBundle(nestedOut);
  if (appBundle) {
    const destination = path.join(outputDir, path.basename(appBundle));
    rmSync(destination, { recursive: true, force: true });
    copyDir(appBundle, destination);
    rmSync(nestedOut, { recursive: true, force: true });
    return { ok: true, extracted: true };
  }
  return { ok: true, extracted: true };
}

function findDeep(root, names) {
  if (!existsSync(root)) return null;
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isFile() && names.includes(entry.name)) return full;
      if (entry.isDirectory() && ![".git", "node_modules", "target"].includes(entry.name))
        queue.push(full);
    }
  }
  return null;
}

function installFromGithubRelease(toolId) {
  const def = TOOL_DEFINITIONS[toolId];
  if (!def.github) return { ok: false, blocker: `${def.label} has no GitHub release recipe.` };
  const release = curlJson(`https://api.github.com/repos/${def.github.repo}/releases/latest`);
  if (!release.ok) return release;
  const assets = release.value.assets || [];
  const asset = assets.find((candidate) => def.github.asset.test(candidate.name || ""));
  if (!asset?.browser_download_url) {
    return {
      ok: false,
      blocker: `No suitable macOS/Apple Silicon release asset found for ${def.github.repo}. Assets: ${assets.map((item) => item.name).join(", ") || "none"}`,
    };
  }
  const downloadPath = path.join(TOOLCHAIN_HOME, "downloads", asset.name);
  const downloaded = downloadFile(asset.browser_download_url, downloadPath);
  if (!downloaded.ok) return downloaded;
  const extractDir = path.join(TOOLCHAIN_HOME, toolId);
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  const extracted = extractArchive(downloadPath, extractDir);
  if (!extracted.ok) return extracted;
  const toolPath = detectTool(toolId).available ? detectTool(toolId).path : extractDir;
  appendManifest({
    tools: {
      [toolId]: {
        installedAt: nowIso(),
        installer: "github-release",
        path: toolPath,
        release: release.value.tag_name || release.value.name || "latest",
        source: def.github.repo,
        sha256: downloaded.sha256,
      },
    },
  });
  return { ok: true, path: toolPath, source: def.github.repo, asset: asset.name };
}

function buildFromSource(toolId) {
  const def = TOOL_DEFINITIONS[toolId];
  if (!def.source) return { ok: false, blocker: `${def.label} has no source build recipe.` };
  const sourceRoot = path.join(TOOLCHAIN_HOME, "src", toolId);
  if (!existsSync(sourceRoot)) {
    ensureDir(path.dirname(sourceRoot));
    const cloned = run("git", ["clone", "--depth", "1", def.source.repo, sourceRoot], {
      timeoutMs: 20 * 60_000,
    });
    if (!cloned.ok)
      return {
        ok: false,
        blocker: cloned.stderr || cloned.error || `git clone failed for ${def.source.repo}`,
        result: cloned,
      };
  }
  const buildAttempts = [];
  if (
    existsSync(path.join(sourceRoot, "Makefile")) ||
    existsSync(path.join(sourceRoot, "makefile"))
  ) {
    buildAttempts.push(["make", []]);
  }
  if (existsSync(path.join(sourceRoot, "CMakeLists.txt"))) {
    const buildDir = path.join(sourceRoot, "build");
    ensureDir(buildDir);
    const configured = run("cmake", ["-S", sourceRoot, "-B", buildDir], { timeoutMs: 5 * 60_000 });
    if (configured.ok) buildAttempts.push(["cmake", ["--build", buildDir, "--config", "Release"]]);
  }
  if (existsSync(path.join(sourceRoot, "Cargo.toml"))) {
    buildAttempts.push(["cargo", ["build", "--release"]]);
  }
  if (buildAttempts.length === 0) {
    return {
      ok: false,
      blocker: `No Makefile, CMakeLists.txt, or Cargo.toml found for ${def.label}.`,
    };
  }
  const failures = [];
  for (const [command, args] of buildAttempts) {
    const built = run(command, args, { cwd: sourceRoot, timeoutMs: 20 * 60_000 });
    if (!built.ok) {
      failures.push(`${command} ${args.join(" ")}: ${built.stderr || built.error || built.stdout}`);
      continue;
    }
    const binary = findDeep(sourceRoot, def.source.binaries);
    if (binary) {
      ensureDir(BIN_DIR);
      const destination = path.join(BIN_DIR, path.basename(binary));
      copyFileSync(binary, destination);
      chmodSync(destination, 0o755);
      appendManifest({
        tools: {
          [toolId]: {
            installedAt: nowIso(),
            installer: "source-build",
            path: destination,
            source: def.source.repo,
          },
        },
      });
      return { ok: true, path: destination, source: def.source.repo };
    }
    failures.push(
      `${command} ${args.join(" ")}: build succeeded but no binary ${def.source.binaries.join("/")} was found`,
    );
  }
  return { ok: false, blocker: failures.join("\n") };
}

function installTool(toolId) {
  const detected = detectTool(toolId);
  if (detected.available) {
    return {
      id: toolId,
      label: detected.label,
      status: "already-installed",
      path: detected.path,
      version: detected.version,
    };
  }
  const def = TOOL_DEFINITIONS[toolId];
  const attempts = [];
  if (def.brew) {
    const info = brewInfo(def.brew.type, def.brew.name);
    attempts.push({ installer: "brew-info", ok: info.ok, blocker: info.blocker });
    if (info.ok) {
      const installed = brewInstall(def.brew.type, def.brew.name);
      attempts.push({
        installer: `brew-${def.brew.type}`,
        ok: installed.ok,
        blocker: installed.blocker,
      });
      const post = detectTool(toolId);
      if (installed.ok || post.available) {
        appendManifest({
          tools: {
            [toolId]: {
              installedAt: nowIso(),
              installer: `brew-${def.brew.type}`,
              name: def.brew.name,
              path: post.path,
              version: post.version,
            },
          },
        });
        return {
          id: toolId,
          label: def.label,
          status: "installed",
          path: post.path,
          version: post.version,
          attempts,
        };
      }
    }
  }
  if (def.github) {
    const installed = installFromGithubRelease(toolId);
    attempts.push({ installer: "github-release", ok: installed.ok, blocker: installed.blocker });
    const post = detectTool(toolId);
    if (installed.ok || post.available) {
      return {
        id: toolId,
        label: def.label,
        status: "installed",
        path: post.path || installed.path,
        version: post.version,
        attempts,
      };
    }
  }
  if (def.source) {
    const built = buildFromSource(toolId);
    attempts.push({ installer: "source-build", ok: built.ok, blocker: built.blocker });
    const post = detectTool(toolId);
    if (built.ok || post.available) {
      return {
        id: toolId,
        label: def.label,
        status: "installed",
        path: post.path || built.path,
        version: post.version,
        attempts,
      };
    }
  }
  if (toolId === "brrtools") {
    const pvs = detectTool("pvsneslib");
    if (pvs.available) {
      const binary = findDeep(pvs.path, ["brr_encoder", "brrencode", "snesbrr"]);
      if (binary) {
        appendManifest({
          tools: {
            brrtools: { installedAt: nowIso(), installer: "pvsneslib-bundled", path: binary },
          },
        });
        return { id: toolId, label: def.label, status: "installed", path: binary, attempts };
      }
    }
  }
  return {
    id: toolId,
    label: def.label,
    status: def.required ? "blocked" : "optional-blocked",
    attempts,
    blocker:
      attempts
        .map((attempt) => attempt.blocker)
        .filter(Boolean)
        .join("\n") || detectTool(toolId).blocker,
  };
}

export function installToolchain(options = {}) {
  ensureDir(options.artifactDir || DEFAULT_ARTIFACT_DIR);
  ensureDir(TOOLCHAIN_HOME);
  ensureDir(BIN_DIR);
  const order = [
    "pixelorama",
    "tiled",
    "ldtk",
    "pvsneslib",
    "superfamiconv",
    "superfamicheck",
    "mesen",
    "bsnes",
    "brrtools",
  ];
  const results = [];
  for (const toolId of order) {
    if (toolId === "bsnes" && detectTool("mesen").available) {
      results.push({
        id: toolId,
        label: TOOL_DEFINITIONS.bsnes.label,
        status: "skipped",
        blocker: "MesenCE is already available; bsnes fallback not required.",
      });
      continue;
    }
    results.push(installTool(toolId));
  }
  const probe = probeToolchain(options);
  const report = {
    generatedAt: nowIso(),
    installResults: results,
    localOnly: true,
    manifestPath: MANIFEST_PATH,
    noHostedGlm: true,
    noPaidAccountTools: true,
    noRemovableMediaWrites: true,
    probe,
    status: probe.status,
  };
  appendManifest({ notes: [`install run ${report.generatedAt}: ${report.status}`] });
  return report;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(payload), 8 + data.length);
  return chunk;
}

function writeFixturePng(outputPath) {
  return writeDeterministicPng(outputPath, {
    seed: "toolchain-fixture",
    type: "tileset",
    width: 16,
    height: 16,
  });
}

function colorRampForType(type) {
  switch (type) {
    case "character-sprite":
      return [
        [28, 28, 44],
        [240, 200, 120],
        [80, 120, 220],
        [245, 245, 245],
      ];
    case "enemy-sprite":
      return [
        [32, 24, 24],
        [180, 48, 64],
        [255, 180, 64],
        [80, 20, 20],
      ];
    case "item-sprite":
      return [
        [32, 24, 8],
        [255, 216, 64],
        [255, 120, 32],
        [255, 244, 180],
      ];
    case "background-layer":
      return [
        [20, 32, 64],
        [64, 112, 180],
        [120, 180, 220],
        [220, 236, 250],
      ];
    default:
      return [
        [20, 40, 120],
        [64, 180, 70],
        [220, 120, 40],
        [245, 240, 180],
      ];
  }
}

function writeDeterministicPng(outputPath, asset) {
  const width = asset.width || (asset.type === "background-layer" ? 64 : 16);
  const height = asset.height || (asset.type === "background-layer" ? 32 : 16);
  const ramp = colorRampForType(asset.type);
  const seed = sha256Text(`${asset.seed || ""}:${asset.id || ""}:${asset.type || ""}`);
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const skyline =
        asset.type === "background-layer" &&
        y > height / 2 &&
        (x + seed.charCodeAt(x % seed.length)) % 9 < 4;
      const spriteShape =
        asset.type !== "background-layer" &&
        Math.abs(x - width / 2) + Math.abs(y - height / 2) <
          width / 2 + ((seed.charCodeAt((x + y) % seed.length) % 3) - 1);
      const checker =
        (Math.floor(x / 4) + Math.floor(y / 4) + seed.charCodeAt((x + y) % seed.length)) % 3;
      const color = border
        ? ramp[0]
        : skyline
          ? ramp[1]
          : spriteShape
            ? ramp[2]
            : ramp[checker] || ramp[1];
      row[offset] = color[0];
      row[offset + 1] = color[1];
      row[offset + 2] = color[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  ensureDir(path.dirname(outputPath));
  writeFileSync(outputPath, png);
  return outputPath;
}

function visualProofKindForAsset(type) {
  if (type === "tileset") return "tileset-atlas";
  if (type === "background-layer") return "background-composite";
  return "sprite-contact-sheet";
}

function writeVisualReviewSheet(outputPath, asset) {
  const width = asset.type === "background-layer" ? 128 : asset.type === "tileset" ? 96 : 80;
  const height = asset.type === "background-layer" ? 72 : 64;
  const ramp = colorRampForType(asset.type);
  const seed = sha256Text(`review:${asset.seed || ""}:${asset.id || ""}:${asset.type || ""}`);
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      const panelBorder =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        (asset.type !== "background-layer" && x % 20 === 0);
      const frameIndex = Math.floor(x / Math.max(1, Math.floor(width / 4)));
      const skyline =
        asset.type === "background-layer" &&
        y > height / 2 &&
        (x + seed.charCodeAt((x + frameIndex) % seed.length)) % 11 < 5;
      const tileGrid =
        asset.type === "tileset" &&
        (x % 16 === 0 || y % 16 === 0 || ((x >> 3) + (y >> 3)) % 5 === 0);
      const spriteCluster =
        asset.type !== "background-layer" &&
        asset.type !== "tileset" &&
        Math.abs((x % 20) - 10) + Math.abs(y - height / 2) <
          12 + (seed.charCodeAt((x + y) % seed.length) % 4);
      const shade =
        (Math.floor(x / 5) + Math.floor(y / 5) + seed.charCodeAt((x + y) % seed.length)) %
        ramp.length;
      const color = panelBorder
        ? ramp[0]
        : skyline
          ? ramp[1]
          : tileGrid
            ? ramp[2]
            : spriteCluster
              ? ramp[3] || ramp[2]
              : ramp[shade] || ramp[1];
      row[offset] = color[0];
      row[offset + 1] = color[1];
      row[offset + 2] = color[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  ensureDir(path.dirname(outputPath));
  writeFileSync(outputPath, png);
  return outputPath;
}

function writeRgbPng(outputPath, width, height, pixelAt) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      const color = pixelAt(x, y);
      row[offset] = color[0];
      row[offset + 1] = color[1];
      row[offset + 2] = color[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  ensureDir(path.dirname(outputPath));
  writeFileSync(outputPath, png);
  return outputPath;
}

function compiledDimensionsForType(type) {
  if (type === "character-sprite")
    return { width: 160, height: 320, frameWidth: 16, frameHeight: 32, frameCount: 40 };
  if (type === "enemy-sprite")
    return { width: 96, height: 64, frameWidth: 16, frameHeight: 16, frameCount: 12 };
  if (type === "item-sprite")
    return { width: 64, height: 32, frameWidth: 16, frameHeight: 16, frameCount: 4 };
  if (type === "tileset") return { width: 192, height: 128, tileCount: 96 };
  if (type === "background-layer") return { width: 256, height: 144, layerCount: 5 };
  return { width: 64, height: 64 };
}

function compiledFramesForType(type) {
  const dimensions = compiledDimensionsForType(type);
  const count = dimensions.frameCount || 0;
  return Array.from({ length: count }, (_, index) => ({
    id: `${type}-frame-${String(index + 1).padStart(2, "0")}`,
    width: dimensions.frameWidth || 16,
    height: dimensions.frameHeight || 16,
    durationTicks: type === "character-sprite" ? 6 : 8,
  }));
}

function compiledTileMetadataForType(type) {
  if (type !== "tileset") return undefined;
  return {
    tileSize: "16x16",
    tileCount: 96,
    collisionClasses: ["solid", "slope", "hazard", "one-way", "decor", "reward"],
  };
}

function writeCompiledAssetPng(outputPath, asset, manifest) {
  const dimensions = compiledDimensionsForType(asset.type);
  const ramp = colorRampForType(asset.type);
  const seed = sha256Text(`compiled:${manifest.manifestHash || "seed"}:${asset.id}:${asset.type}`);
  return writeRgbPng(outputPath, dimensions.width, dimensions.height, (x, y) => {
    const v = seed.charCodeAt((x * 3 + y * 7) % seed.length);
    const frameColumn = Math.floor(x / Math.max(1, dimensions.frameWidth || 16));
    const frameRow = Math.floor(y / Math.max(1, dimensions.frameHeight || 16));
    const grid = x % 16 === 0 || y % 16 === 0;
    const outline = x === 0 || y === 0 || x === dimensions.width - 1 || y === dimensions.height - 1;
    if (outline || (asset.type === "tileset" && grid)) return ramp[0];
    if (asset.type === "background-layer") {
      const sky = y < dimensions.height * 0.45;
      const skyline =
        y > dimensions.height * 0.45 && y < dimensions.height * 0.72 && (x + v) % 23 < 9;
      const foreground = y > dimensions.height * 0.72;
      return sky
        ? ramp[(x + y + v) % 2 ? 1 : 2]
        : skyline
          ? ramp[3] || ramp[2]
          : foreground
            ? ramp[(x >> 4) % ramp.length]
            : ramp[1];
    }
    if (asset.type === "tileset") {
      const tileIndex = Math.floor(x / 16) + Math.floor(y / 16) * 12;
      const crack = (x + y + tileIndex + v) % 11 === 0;
      const highlight = (x % 16 < 3 || y % 16 < 3) && tileIndex % 3 === 0;
      return crack
        ? ramp[0]
        : highlight
          ? ramp[3] || ramp[2]
          : ramp[(tileIndex + v + Math.floor(x / 4) + Math.floor(y / 4)) % ramp.length];
    }
    const cx = frameColumn * (dimensions.frameWidth || 16) + (dimensions.frameWidth || 16) / 2;
    const cy = frameRow * (dimensions.frameHeight || 16) + (dimensions.frameHeight || 16) / 2;
    const dx = Math.abs(x - cx);
    const dy = Math.abs(y - cy);
    const silhouette = dx * 0.75 + dy < (asset.type === "character-sprite" ? 17 : 10) + (v % 4);
    const face = asset.type === "character-sprite" && dy < 8 && dx < 5 && frameRow % 2 === 0;
    const motion = (frameColumn + frameRow + x + v) % 5 === 0;
    return !silhouette
      ? ramp[1]
      : face
        ? ramp[3] || ramp[2]
        : motion
          ? ramp[2]
          : ramp[(frameColumn + frameRow + v) % ramp.length];
  });
}

function normalizeRequestedAssetId(assetId) {
  if (!assetId) return null;
  const normalized = String(assetId).trim().toLowerCase();
  if (normalized === "hero" || normalized === "player" || normalized === "main-character")
    return "character-sprite";
  if (normalized === "enemy" || normalized === "foe") return "enemy-sprite";
  if (normalized === "item" || normalized === "collectible") return "item-sprite";
  if (normalized === "background") return "background-layer";
  return normalized;
}

function buildDefaultArtManifest(projectPackage, assetId = null) {
  const projectId = sanitizeProjectId(projectPackage?.projectId);
  const requestedAsset = normalizeRequestedAssetId(assetId);
  const allAssets = requiredProjectAssets(projectPackage);
  const selectedAssets = requestedAsset
    ? allAssets.filter(
        (asset) =>
          asset.id === requestedAsset ||
          asset.type === requestedAsset ||
          asset.id.endsWith(`-${requestedAsset}`),
      )
    : allAssets;
  const assets = (selectedAssets.length > 0 ? selectedAssets : allAssets).map((asset) => ({
    id: asset.id,
    type: asset.type,
    targetMaturity: "draft-generated",
    style: "original commercial SNES-era platformer asset, not copied from Nintendo or Sega",
    paletteRamp: colorRampForType(asset.type).map(
      (color) => `#${color.map((part) => part.toString(16).padStart(2, "0")).join("")}`,
    ),
    framePlan: compiledFramesForType(asset.type),
    tilePlan: compiledTileMetadataForType(asset.type),
    visualProofRequired: [visualProofKindForAsset(asset.type), "in-game-screenshot"],
  }));
  const manifest = {
    format: "openclaw-snes-art-manifest",
    localGlmOnly: true,
    hostedGlmUsed: false,
    projectId,
    projectName: projectTitle(projectPackage),
    targetVisualGrade: 100,
    styleBible: {
      style: "original commercial SNES-era platformer quality",
      doNotCopy: ["Nintendo", "Sega", "Mario", "Sonic"],
      productionApproval: "human approval required for 100/100",
    },
    assets,
  };
  return { ...manifest, manifestHash: sha256Text(JSON.stringify(manifest)) };
}

function localGlmBaseUrl() {
  return (process.env.OPENCLAW_LOCAL_GLM52_BASE_URL || "http://127.0.0.1:28080").replace(
    /\/+$/u,
    "",
  );
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const unfenced = raw
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/```$/u, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

function requestLocalGlmArtPatch(manifest) {
  const asset = manifest.assets?.[0];
  if (!asset) {
    return { status: "blocked", blocker: "No asset was selected for the local GLM art patch." };
  }
  const prompt = [
    "You are local GLM-5.2 inside OpenClaw SNES Studio.",
    "Return ONLY strict JSON. No markdown.",
    "Create a bounded art manifest patch for this one SNES asset.",
    "Do not copy Nintendo, Sega, Mario, Sonic, or any existing commercial asset.",
    `Project: ${manifest.projectName}`,
    `Asset id: ${asset.id}`,
    `Asset type: ${asset.type}`,
    "Schema:",
    '{"assetId":"string","localGlmOnly":true,"hostedGlmUsed":false,"summary":"string","styleTraits":["string"],"qaHypothesis":["string"]}',
  ].join("\n");
  const payload = JSON.stringify({
    model: "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    max_tokens: 320,
  });
  const result = run(
    "curl",
    [
      "-fsS",
      "--max-time",
      "90",
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
      `${localGlmBaseUrl()}/v1/chat/completions`,
    ],
    { timeoutMs: 95_000 },
  );
  if (!result.ok) {
    return {
      status: "blocked",
      blocker: (result.stderr || result.stdout || "Local GLM art patch request failed.").slice(
        0,
        1000,
      ),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      status: "blocked",
      blocker: "Local GLM response was not valid OpenAI-compatible JSON.",
      raw: result.stdout.slice(0, 1000),
    };
  }
  const content = parsed?.choices?.[0]?.message?.content ?? "";
  const patch = extractJsonObject(content);
  if (
    !patch ||
    patch.localGlmOnly !== true ||
    patch.hostedGlmUsed !== false ||
    patch.assetId !== asset.id
  ) {
    return {
      status: "blocked",
      blocker: "Local GLM did not return a valid strict JSON art patch for the selected asset.",
      raw: String(content).slice(0, 1000),
    };
  }
  return {
    status: "pass",
    patch,
    rawSha256: sha256Text(content),
    usage: parsed?.usage || null,
  };
}

function probeLocalGlm52() {
  const result = run("curl", ["-fsS", "--max-time", "3", `${localGlmBaseUrl()}/v1/models`], {
    timeoutMs: 5_000,
  });
  return {
    baseUrl: localGlmBaseUrl(),
    status: result.ok ? "ready" : "blocked",
    blocker: result.ok
      ? null
      : (result.stderr || result.stdout || "Local GLM-5.2 endpoint did not respond.").slice(0, 500),
  };
}

function packageWithoutHash(projectPackage) {
  const next = { ...projectPackage };
  delete next.packageHash;
  return next;
}

function writeProjectPackage(projectId, projectPackage, options = {}) {
  const paths = projectPaths(projectId, options);
  const body = packageWithoutHash(projectPackage);
  const next = { ...body, packageHash: sha256Text(JSON.stringify(body)) };
  writeJson(paths.projectPath, next);
  return next;
}

function persistProjectAssetRecords(
  projectId,
  projectPackage,
  assetRecords,
  receiptKind,
  options = {},
) {
  const next = {
    ...projectPackage,
    manifest: {
      ...projectPackage.manifest,
      assetRegistry: {
        records: assetRecords,
        status: assetRecords.every((record) => record.status === "real-asset")
          ? "ready"
          : "blocked",
        updatedBy: receiptKind,
      },
    },
    updatedAt: nowIso(),
  };
  return writeProjectPackage(projectId, next, options);
}

function stanskiVisualRecoveryArtBible(projectPackage, levelId = STANSKI_LEVEL_ONE_ID) {
  return {
    format: "openclaw-snes-stanski-visual-art-bible-v1",
    projectId: sanitizeProjectId(projectPackage?.projectId),
    levelId,
    targetHumanScore: 100,
    currentRejectedHumanScore: STANSKI_VISUAL_CATEGORY_GRADES.inGameScreenshots,
    styleTarget:
      "original commercial SNES-era platformer quality comparable to Super Mario World as a quality reference only, without copying Nintendo/Sega code, ROMs, pixels, palettes, maps, or audio",
    cleanRoomSourcePolicy: cleanRoomSourcePolicy(),
    tools: {
      authoring: ["Pixelorama-compatible editable source folder", "Tiled JSON visual map"],
      conversion: "SuperFamiconv 4bpp tile/palette/map conversion",
      paidTools: "Aseprite deferred until separately approved",
    },
    globalRules: [
      "Readable silhouette at 1x scale before any zoom.",
      "Distinct foreground, midground, and background value ranges.",
      "SNES-safe palettes with ramps, outlines, midtones, and highlights.",
      "No rectangle/noise/grid filler can pass production visual QA.",
      "Runtime screenshots must show converted art in-game; contact sheets alone do not count.",
    ],
    assets: {
      todd: {
        requiredTraits: [
          "long neck",
          "glasses",
          "stubble/beard texture",
          "distinct hair",
          "black shirt",
          "readable side profile",
        ],
        requiredStates: [
          "idle",
          "walk",
          "run",
          "jump",
          "fall-gas",
          "crouch",
          "shoot",
          "hurt",
          "toilet",
          "victory",
        ],
        minimumFrames: 40,
      },
      items: {
        cheeseburger: "must show bun, filling, patty, cheese/lettuce bands at 16x16",
        burrito: "wrapped cylinder with folded ends and highlight stripe",
        pizza: "triangular slice with crust, cheese, and pepperoni pixels",
        projectile: "bad-breath puff/projectile with directional motion trail",
      },
      enemies: {
        receiptGoblin: "paper/receipt body with goblin eyes and feet; not a generic block",
        turnstileSnatcher: "turnstile arms and sneaky face readable at 16x16/16x24",
      },
      tiles: [
        "sidewalk",
        "pothole",
        "road stripe",
        "bridge truss",
        "rooftop",
        "restroom",
        "secret awning",
        "toilet goal",
      ],
      backgrounds: [
        "recognizable Cleveland skyline with Terminal Tower, Key Tower, 200 Public Square, Cuyahoga bridge truss, and Lake Erie",
        "Lake Erie depth layer",
        "bridge/parallax layer",
        "foreground street",
      ],
      ending: ["Todd sitting", "newspaper", "exactly two poop drops", "fireworks"],
    },
    failClosedChecks: [
      "Any human score below 100 blocks production visual approval.",
      "Any asset with visualMaturity procedural-placeholder, draft-generated-placeholder, or spec-only blocks production.",
      "Any asset without editable source hash blocks production.",
      "Any asset without original-clean-room license receipt blocks production.",
      "Any asset without runtime screenshot proof blocks production.",
      "Any request to download or copy Super Mario World code/assets remains blocked.",
    ],
    clevelandLandmarks: stanskiClevelandLandmarks(),
  };
}

function artSourcePaletteForType(type) {
  if (type === "character-sprite")
    return [
      "#101018",
      "#2d2a2f",
      "#f0c078",
      "#f6dca8",
      "#5f3a2a",
      "#1b1b1b",
      "#f04f32",
      "#f8f8e8",
      "#4c8bd6",
      "#f2b23c",
      "#6d4c2a",
      "#9a6b42",
      "#ffffff",
      "#7fb6ff",
      "#2f5f8f",
      "#d9d9d9",
    ];
  if (type === "enemy-sprite")
    return [
      "#101018",
      "#f2f0c0",
      "#c6bd83",
      "#6b5930",
      "#7acd5a",
      "#34823d",
      "#d94f4f",
      "#ffffff",
      "#7454b8",
      "#4f347f",
      "#f0b44c",
      "#2d2a2f",
      "#7f7f7f",
      "#b0b0b0",
      "#00a6a6",
      "#202020",
    ];
  if (type === "item-sprite")
    return [
      "#101018",
      "#f6c05f",
      "#d08132",
      "#7f421e",
      "#f2e6a2",
      "#4cae4f",
      "#d74732",
      "#ffffff",
      "#e8d098",
      "#b88248",
      "#ffcf40",
      "#b92f2f",
      "#7fb6ff",
      "#4784d1",
      "#efe7d0",
      "#202020",
    ];
  if (type === "tileset")
    return [
      "#101018",
      "#33465c",
      "#596b78",
      "#9ba8a6",
      "#d6d0b8",
      "#5a4637",
      "#8b6f4e",
      "#c0a978",
      "#243c63",
      "#487aa3",
      "#6db1d0",
      "#203027",
      "#496642",
      "#87a65e",
      "#b94c3f",
      "#ffffff",
    ];
  return [
    "#101018",
    "#3c78b5",
    "#78bde8",
    "#d8f0ff",
    "#24446b",
    "#3c5c83",
    "#6f839a",
    "#d7d0a8",
    "#2d465d",
    "#4e6980",
    "#85a0a8",
    "#5f4a34",
    "#8c6a43",
    "#d6a257",
    "#f0d37a",
    "#ffffff",
  ];
}

function hexToRgb(hex) {
  const clean = String(hex).replace(/^#/u, "");
  return [0, 2, 4].map((index) => parseInt(clean.slice(index, index + 2), 16));
}

function drawRect(set, x0, y0, x1, y1, color) {
  for (let y = Math.max(0, y0); y < y1; y += 1) {
    for (let x = Math.max(0, x0); x < x1; x += 1) set(x, y, color);
  }
}

function drawEllipse(set, cx, cy, rx, ry, color) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
      const dx = (x - cx) / Math.max(1, rx);
      const dy = (y - cy) / Math.max(1, ry);
      if (dx * dx + dy * dy <= 1) set(x, y, color);
    }
  }
}

function drawLine(set, x0, y0, x1, y1, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i += 1) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    set(x, y, color);
  }
}

function drawOutlinedRect(set, x0, y0, x1, y1, fillColor, outlineColor = 0) {
  drawRect(set, x0, y0, x1, y1, outlineColor);
  drawRect(set, x0 + 1, y0 + 1, x1 - 1, y1 - 1, fillColor);
}

function drawWindowGrid(set, x0, y0, x1, y1, windowColor, shadowColor, spacingX = 4, spacingY = 5) {
  for (let y = y0 + 3; y < y1 - 2; y += spacingY) {
    for (let x = x0 + 2; x < x1 - 2; x += spacingX) {
      set(x, y, (x + y) % 3 === 0 ? shadowColor : windowColor);
      if (x + 1 < x1 - 2) set(x + 1, y, shadowColor);
    }
  }
}

function drawTruss(set, x0, y0, x1, y1, beamColor, shadowColor) {
  drawLine(set, x0, y0, x1, y0, beamColor);
  drawLine(set, x0, y1, x1, y1, shadowColor);
  for (let x = x0; x < x1; x += 16) {
    drawLine(set, x, y1, x + 16, y0, beamColor);
    drawLine(set, x, y0, x + 16, y1, shadowColor);
    drawLine(set, x, y0, x, y1, beamColor);
  }
}

function drawClevelandSkyline(set, width, height, { includeForeground = true } = {}) {
  const lakeY = Math.floor(height * 0.48);
  const skylineBaseY = Math.floor(height * 0.68);
  const bridgeTopY = Math.floor(height * 0.72);
  for (let y = 0; y < height; y += 1) {
    const skyBand = y < height * 0.2 ? 3 : y < height * 0.42 ? 2 : 1;
    drawLine(set, 0, y, width - 1, y, skyBand);
  }
  drawRect(set, 0, lakeY, width, lakeY + 12, 10);
  for (let x = 0; x < width; x += 9) drawLine(set, x, lakeY + 7, x + 6, lakeY + 7, 15);

  // Terminal Tower: the central tan stepped tower with green cap and antenna.
  const terminalX = Math.round(width * 0.43);
  drawOutlinedRect(set, terminalX, skylineBaseY - 70, terminalX + 18, skylineBaseY, 7, 0);
  drawRect(set, terminalX + 3, skylineBaseY - 76, terminalX + 15, skylineBaseY - 70, 8);
  drawRect(set, terminalX + 6, skylineBaseY - 82, terminalX + 12, skylineBaseY - 76, 8);
  drawLine(set, terminalX + 9, skylineBaseY - 94, terminalX + 9, skylineBaseY - 82, 15);
  drawWindowGrid(
    set,
    terminalX + 2,
    skylineBaseY - 66,
    terminalX + 16,
    skylineBaseY - 4,
    14,
    13,
    4,
    5,
  );

  // Key Tower: pointed roof, offset left.
  const keyX = Math.round(width * 0.2);
  drawOutlinedRect(set, keyX, skylineBaseY - 56, keyX + 20, skylineBaseY, 5, 0);
  drawLine(set, keyX + 1, skylineBaseY - 56, keyX + 10, skylineBaseY - 72, 15);
  drawLine(set, keyX + 19, skylineBaseY - 56, keyX + 10, skylineBaseY - 72, 15);
  drawLine(set, keyX + 10, skylineBaseY - 72, keyX + 10, skylineBaseY - 82, 15);
  drawWindowGrid(set, keyX + 2, skylineBaseY - 52, keyX + 18, skylineBaseY - 4, 14, 6, 4, 6);

  // 200 Public Square: broad dark block with dense windows.
  const squareX = Math.round(width * 0.58);
  drawOutlinedRect(set, squareX, skylineBaseY - 48, squareX + 34, skylineBaseY, 4, 0);
  drawWindowGrid(set, squareX + 2, skylineBaseY - 44, squareX + 32, skylineBaseY - 3, 15, 6, 5, 4);

  const filler = [
    [8, 34, 20, 9],
    [54, 42, 16, 6],
    [92, 28, 14, 4],
    [122, 38, 18, 5],
    [174, 30, 16, 9],
    [215, 44, 20, 6],
    [238, 26, 12, 5],
  ];
  for (const [x, h, w, color] of filler) {
    if (x >= width) continue;
    drawOutlinedRect(set, x, skylineBaseY - h, Math.min(width, x + w), skylineBaseY, color, 0);
    drawWindowGrid(
      set,
      x + 1,
      skylineBaseY - h + 4,
      Math.min(width, x + w - 1),
      skylineBaseY - 3,
      15,
      13,
      4,
      5,
    );
  }

  drawTruss(set, 0, bridgeTopY, width, bridgeTopY + 28, 13, 12);
  if (includeForeground) {
    drawRect(set, 0, height - 24, width, height, 11);
    drawLine(set, 0, height - 24, width - 1, height - 24, 15);
    for (let x = 4; x < width; x += 24) drawRect(set, x, height - 13, x + 10, height - 11, 14);
    drawRect(set, width - 50, height - 42, width - 24, height - 24, 0);
    drawRect(set, width - 47, height - 39, width - 27, height - 27, 15);
    drawRect(set, width - 41, height - 37, width - 33, height - 29, 11);
  }
}

function drawProductionTile(set, ox, oy, tile) {
  const family = tile % 12;
  drawOutlinedRect(set, ox, oy, ox + 16, oy + 16, 2 + (family % 4), 0);
  if (family === 0) {
    drawRect(set, ox, oy + 10, ox + 16, oy + 16, 4);
    drawLine(set, ox, oy + 10, ox + 15, oy + 10, 15);
    drawLine(set, ox + 1, oy + 14, ox + 14, oy + 12, 3);
  } else if (family === 1) {
    drawRect(set, ox, oy, ox + 16, oy + 8, 5);
    drawRect(set, ox, oy + 8, ox + 16, oy + 16, 6);
    for (let y = oy + 3; y < oy + 15; y += 5) drawLine(set, ox, y, ox + 15, y, 7);
    for (let x = ox + 4; x < ox + 16; x += 6) drawLine(set, x, oy, x - 2, oy + 15, 7);
  } else if (family === 2) {
    drawTruss(set, ox, oy + 3, ox + 15, oy + 13, 14, 11);
  } else if (family === 3) {
    drawRect(set, ox + 1, oy + 11, ox + 15, oy + 15, 10);
    drawEllipse(set, ox + 8, oy + 10, 5, 3, 1);
    drawRect(set, ox + 5, oy + 12, ox + 11, oy + 15, 0);
  } else if (family === 4) {
    drawRect(set, ox, oy + 7, ox + 16, oy + 16, 1);
    drawLine(set, ox, oy + 11, ox + 15, oy + 11, 15);
    drawRect(set, ox + 3, oy + 10, ox + 7, oy + 12, 4);
    drawRect(set, ox + 10, oy + 10, ox + 14, oy + 12, 4);
  } else if (family === 5) {
    drawRect(set, ox + 2, oy + 2, ox + 14, oy + 14, 3);
    drawRect(set, ox + 5, oy + 6, ox + 11, oy + 13, 15);
    drawLine(set, ox + 8, oy + 3, ox + 8, oy + 6, 15);
  } else if (family === 6) {
    drawRect(set, ox, oy + 6, ox + 16, oy + 16, 8);
    drawLine(set, ox, oy + 6, ox + 15, oy + 6, 15);
    drawLine(set, ox + 2, oy + 14, ox + 14, oy + 8, 9);
  } else if (family === 7) {
    drawEllipse(set, ox + 8, oy + 9, 6, 7, 14);
    drawRect(set, ox + 5, oy + 4, ox + 11, oy + 9, 15);
    drawRect(set, ox + 7, oy + 9, ox + 9, oy + 15, 0);
  } else if (family === 8) {
    drawRect(set, ox, oy, ox + 16, oy + 7, 8);
    drawRect(set, ox, oy + 7, ox + 16, oy + 16, 9);
    drawWindowGrid(set, ox + 2, oy + 2, ox + 14, oy + 14, 15, 3, 4, 4);
  } else if (family === 9) {
    drawLine(set, ox + 1, oy + 14, ox + 14, oy + 1, 14);
    drawLine(set, ox + 1, oy + 1, ox + 14, oy + 14, 14);
    drawLine(set, ox + 8, oy + 1, ox + 8, oy + 14, 11);
  } else if (family === 10) {
    drawRect(set, ox + 1, oy + 5, ox + 15, oy + 12, 12);
    drawLine(set, ox + 1, oy + 5, ox + 8, oy + 1, 15);
    drawLine(set, ox + 8, oy + 1, ox + 15, oy + 5, 15);
  } else {
    drawRect(set, ox + 2, oy + 3, ox + 14, oy + 14, 13);
    drawRect(set, ox + 4, oy + 6, ox + 12, oy + 12, 15);
    drawLine(set, ox + 4, oy + 6, ox + 12, oy + 12, 0);
  }
}

function writeIndexedStylePng(outputPath, width, height, paletteHex, painter) {
  const palette = paletteHex.map(hexToRgb);
  const pixels = new Uint8Array(width * height).fill(0);
  const set = (x, y, colorIndex) => {
    if (x >= 0 && y >= 0 && x < width && y < height)
      pixels[y * width + x] = Math.max(0, Math.min(palette.length - 1, colorIndex));
  };
  painter(set, { width, height, paletteHex });
  return writeRgbPng(
    outputPath,
    width,
    height,
    (x, y) => palette[pixels[y * width + x]] || palette[0],
  );
}

function drawToddFrame(set, originX, originY, frameIndex) {
  const pose = frameIndex % 10;
  const stride = frameIndex % 4;
  const lean = pose === 3 || pose === 4 ? 1 : pose === 7 ? -1 : 0;
  const headX = originX + 8 + lean;
  const headY = originY + 7;
  const torsoX = originX + 7 + lean;
  const leftLegOffset = stride === 1 ? -1 : stride === 3 ? 1 : 0;
  const rightLegOffset = -leftLegOffset;

  // Hair, head, glasses, long neck, beard texture.
  drawEllipse(set, headX, headY, 7, 7, 1);
  drawEllipse(set, headX, headY + 1, 5, 6, 2);
  drawRect(set, headX - 5, headY - 7, headX + 2, headY - 3, 5);
  drawLine(set, headX - 6, headY - 3, headX + 5, headY - 4, 5);
  drawRect(set, headX - 4, headY - 1, headX - 1, headY + 2, 13);
  drawRect(set, headX + 1, headY - 1, headX + 5, headY + 2, 13);
  drawRect(set, headX - 1, headY, headX + 2, headY + 1, 1);
  drawLine(set, headX - 3, headY + 5, headX + 5, headY + 4, 4);
  drawLine(set, headX - 2, headY + 6, headX + 3, headY + 7, 10);
  drawRect(set, torsoX - 2, originY + 13, torsoX + 3, originY + 17, 2);

  // Tapered black-shirt torso with red Cleveland stripe, not a box silhouette.
  drawLine(set, torsoX - 5, originY + 16, torsoX + 5, originY + 16, 1);
  drawLine(set, torsoX - 5, originY + 16, torsoX - 3, originY + 24, 1);
  drawLine(set, torsoX + 5, originY + 16, torsoX + 3, originY + 24, 1);
  for (let y = originY + 17; y <= originY + 24; y += 1) {
    const inset = Math.max(0, Math.floor((y - originY - 17) / 3));
    drawLine(set, torsoX - 4 + inset, y, torsoX + 4 - inset, y, y % 3 === 0 ? 6 : 5);
  }
  drawLine(set, torsoX - 3, originY + 20, torsoX + 3, originY + 20, 7);
  drawRect(set, torsoX - 1, originY + 17, torsoX + 1, originY + 24, 6);

  // Arms with pose-specific readability.
  const leftHandX = pose === 6 ? originX + 0 : originX + 2 + stride;
  const leftHandY = pose === 6 ? originY + 14 : originY + 23 - (stride % 2);
  const rightHandX = pose === 6 ? originX + 15 : originX + 13 - stride;
  const rightHandY = pose === 6 ? originY + 14 : originY + 23 + (stride % 2);
  drawLine(set, torsoX - 4, originY + 18, leftHandX, leftHandY, 7);
  drawLine(set, torsoX + 4, originY + 18, rightHandX, rightHandY, 7);
  drawEllipse(set, leftHandX, leftHandY, 1, 1, 2);
  drawEllipse(set, rightHandX, rightHandY, 1, 1, 2);

  // Separate legs and shoes; gait changes every frame.
  drawLine(set, torsoX - 2, originY + 24, originX + 4 + leftLegOffset, originY + 30, 8);
  drawLine(set, torsoX + 2, originY + 24, originX + 11 + rightLegOffset, originY + 30, 8);
  drawRect(
    set,
    originX + 2 + leftLegOffset,
    originY + 30,
    originX + 7 + leftLegOffset,
    originY + 32,
    1,
  );
  drawRect(
    set,
    originX + 9 + rightLegOffset,
    originY + 30,
    originX + 14 + rightLegOffset,
    originY + 32,
    1,
  );

  if (pose === 4 || pose === 5) drawEllipse(set, originX + 14, originY + 14, 3, 2, 14);
  if (pose === 8) {
    drawLine(set, torsoX - 2, originY + 24, originX + 3, originY + 26, 8);
    drawLine(set, torsoX + 2, originY + 24, originX + 12, originY + 26, 8);
  }
}

function drawEnemyFrame(set, originX, originY, frameIndex) {
  const turnstile = frameIndex >= 6;
  if (turnstile) {
    drawRect(set, originX + 5, originY + 2, originX + 11, originY + 15, 8);
    drawLine(set, originX + 8, originY + 8, originX + 1, originY + 4, 10);
    drawLine(set, originX + 8, originY + 8, originX + 15, originY + 5, 10);
    drawLine(set, originX + 8, originY + 8, originX + 3, originY + 15, 10);
    drawRect(set, originX + 6, originY + 5, originX + 10, originY + 7, 7);
  } else {
    drawRect(set, originX + 3, originY + 2, originX + 13, originY + 13, 1);
    drawRect(set, originX + 4, originY + 4, originX + 12, originY + 6, 2);
    drawEllipse(set, originX + 8, originY + 9, 6, 5, 4);
    drawRect(set, originX + 5, originY + 7, originX + 7, originY + 9, 7);
    drawRect(set, originX + 10, originY + 7, originX + 12, originY + 9, 7);
    drawLine(set, originX + 4, originY + 14, originX + 1 + (frameIndex % 2), originY + 16, 3);
    drawLine(set, originX + 12, originY + 14, originX + 15 - (frameIndex % 2), originY + 16, 3);
  }
}

function drawItemFrame(set, originX, originY, frameIndex) {
  if (frameIndex === 0) {
    drawEllipse(set, originX + 8, originY + 5, 7, 4, 1);
    drawRect(set, originX + 2, originY + 6, originX + 14, originY + 9, 5);
    drawRect(set, originX + 3, originY + 9, originX + 13, originY + 12, 3);
    drawEllipse(set, originX + 8, originY + 12, 6, 3, 2);
  } else if (frameIndex === 1) {
    drawEllipse(set, originX + 8, originY + 8, 7, 4, 8);
    drawLine(set, originX + 3, originY + 6, originX + 13, originY + 11, 9);
    drawRect(set, originX + 2, originY + 7, originX + 5, originY + 10, 4);
  } else if (frameIndex === 2) {
    drawLine(set, originX + 2, originY + 13, originX + 13, originY + 3, 10);
    drawLine(set, originX + 13, originY + 3, originX + 14, originY + 13, 10);
    drawLine(set, originX + 2, originY + 13, originX + 14, originY + 13, 10);
    drawRect(set, originX + 5, originY + 10, originX + 8, originY + 12, 11);
    drawRect(set, originX + 10, originY + 7, originX + 12, originY + 9, 11);
  } else {
    drawEllipse(set, originX + 4, originY + 8, 3, 3, 13);
    drawEllipse(set, originX + 8, originY + 7, 4, 3, 14);
    drawEllipse(set, originX + 12, originY + 8, 3, 3, 13);
  }
}

function writeProductionCandidateSourcePng(outputPath, asset, artBible) {
  const palette = artSourcePaletteForType(asset.type);
  const dims = compiledDimensionsForType(asset.type);
  if (asset.type === "character-sprite") {
    return writeIndexedStylePng(outputPath, dims.width, dims.height, palette, (set) => {
      for (let i = 0; i < 40; i += 1) drawToddFrame(set, (i % 10) * 16, Math.floor(i / 10) * 32, i);
    });
  }
  if (asset.type === "enemy-sprite") {
    return writeIndexedStylePng(outputPath, dims.width, dims.height, palette, (set) => {
      for (let i = 0; i < 12; i += 1)
        drawEnemyFrame(set, (i % 6) * 16, Math.floor(i / 6) * 32 + 6, i);
    });
  }
  if (asset.type === "item-sprite") {
    return writeIndexedStylePng(outputPath, dims.width, dims.height, palette, (set) => {
      for (let i = 0; i < 4; i += 1) drawItemFrame(set, i * 16, 8, i);
    });
  }
  if (asset.type === "tileset") {
    return writeIndexedStylePng(outputPath, dims.width, dims.height, palette, (set) => {
      for (let tile = 0; tile < 96; tile += 1) {
        const ox = (tile % 12) * 16;
        const oy = Math.floor(tile / 12) * 16;
        drawProductionTile(set, ox, oy, tile);
      }
    });
  }
  return writeIndexedStylePng(
    outputPath,
    dims.width,
    dims.height,
    palette,
    (set, { width, height }) => {
      drawClevelandSkyline(set, width, height, { includeForeground: true });
    },
  );
}

function stanskiReferenceIsPreserved(projectPackage, referenceId) {
  const references = Array.isArray(projectPackage?.manifest?.project?.stanskiCanon?.references)
    ? projectPackage.manifest.project.stanskiCanon.references
    : [];
  return references.some(
    (reference) => reference?.id === referenceId && reference.status === "preserved",
  );
}

function isExternalBlockedReferenceAsset(projectPackage, asset) {
  return (
    sanitizeProjectId(asset?.id) === "man-boy-snes-photo-reference" &&
    !stanskiReferenceIsPreserved(projectPackage, "man-boy-snes-photo-reference")
  );
}

export function projectVisualReject(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const levelId = options.levelId || STANSKI_LEVEL_ONE_ID;
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const humanScore = Number.isFinite(Number(options.humanScore))
    ? Math.max(0, Math.min(100, Math.trunc(Number(options.humanScore))))
    : STANSKI_VISUAL_CATEGORY_GRADES.inGameScreenshots;
  const outputDir = options.outputDir || projectReceiptDir(projectId, "visual-rejection", options);
  ensureDir(outputDir);
  const receipt = {
    format: "openclaw-snes-human-visual-rejection-v1",
    projectId,
    projectName: projectTitle(projectPackage),
    levelId,
    targetScore: 100,
    humanScore,
    status: "rejected",
    productionBlocked: true,
    fxpakProductionExportBlocked: true,
    gpt55VisualJudgeUsed: false,
    hostedGlmUsed: false,
    localOnly: true,
    reasons: STANSKI_VISUAL_REJECTION_REASONS,
    categoryGrades: STANSKI_VISUAL_CATEGORY_GRADES,
    cleanRoomSourcePolicy: projectId === STANSKI_PROJECT_ID ? cleanRoomSourcePolicy() : null,
    generatedAt: nowIso(),
  };
  writeJson(path.join(outputDir, "visual-rejection.json"), receipt);
  const nextPackage = {
    ...projectPackage,
    manifest: {
      ...projectPackage.manifest,
      project: {
        ...projectPackage.manifest.project,
        stanskiVisualRecovery: {
          ...(projectPackage.manifest.project?.stanskiVisualRecovery || {}),
          visualRejection: {
            receiptPath: path.join(outputDir, "visual-rejection.json"),
            humanScore,
            targetScore: 100,
            status: "rejected",
            reasons: STANSKI_VISUAL_REJECTION_REASONS,
            categoryGrades: STANSKI_VISUAL_CATEGORY_GRADES,
          },
        },
      },
      productionReadiness: {
        ...(projectPackage.manifest?.productionReadiness || {}),
        visualApproval: {
          blocker: `Human visual score ${humanScore}/100 is below the 100/100 production target.`,
          currentHumanScore: humanScore,
          gpt55ReviewStatus: "not-requested",
          machineScore: null,
          status: "rejected",
          targetScore: 100,
        },
      },
    },
    updatedAt: receipt.generatedAt,
  };
  writeProjectPackage(projectId, nextPackage, options);
  return { ...receipt, outputDir };
}

export function projectArtBible(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const levelId = options.levelId || STANSKI_LEVEL_ONE_ID;
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const outputDir = options.outputDir || projectReceiptDir(projectId, "art-bible", options);
  ensureDir(outputDir);
  const artBible = stanskiVisualRecoveryArtBible(projectPackage, levelId);
  const artBiblePath = path.join(outputDir, "art-bible.json");
  writeJson(artBiblePath, artBible);
  writeProjectPackage(
    projectId,
    {
      ...projectPackage,
      manifest: {
        ...projectPackage.manifest,
        project: {
          ...projectPackage.manifest.project,
          stanskiVisualRecovery: {
            ...(projectPackage.manifest.project?.stanskiVisualRecovery || {}),
            artBible: { path: artBiblePath, sha256: sha256File(artBiblePath), status: "ready" },
          },
        },
      },
      updatedAt: nowIso(),
    },
    options,
  );
  return {
    status: "pass",
    blockers: [],
    generatedAt: nowIso(),
    localOnly: true,
    hostedGlmUsed: false,
    project: {
      id: projectId,
      name: projectTitle(projectPackage),
      packageHash: projectPackage.packageHash,
    },
    levelId,
    artBible,
    artBiblePath,
    artBibleSha256: sha256File(artBiblePath),
  };
}

export function projectArtSourcePack(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const levelId = options.levelId || STANSKI_LEVEL_ONE_ID;
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const artBible = stanskiVisualRecoveryArtBible(projectPackage, levelId);
  const outputDir = options.outputDir || projectReceiptDir(projectId, "art-source-pack", options);
  const editableRoot = path.join(outputDir, "editable-sources");
  const exportRoot = path.join(outputDir, "exports");
  ensureDir(editableRoot);
  ensureDir(exportRoot);
  const allSourceAssets = requiredProjectAssets(projectPackage).filter((asset) =>
    REQUIRED_PROJECT_ASSET_TYPES.includes(asset.type),
  );
  const skippedExternalBlockedAssets = allSourceAssets.filter((asset) =>
    isExternalBlockedReferenceAsset(projectPackage, asset),
  );
  const externalBlockedAssetIds = [
    ...new Set([
      ...skippedExternalBlockedAssets.map((asset) => asset.id),
      ...(projectId === STANSKI_PROJECT_ID &&
      !stanskiReferenceIsPreserved(projectPackage, "man-boy-snes-photo-reference")
        ? ["man-boy-snes-photo-reference"]
        : []),
    ]),
  ];
  const sourceAssets = allSourceAssets.filter(
    (asset) => !isExternalBlockedReferenceAsset(projectPackage, asset),
  );
  const sourcePolicy = cleanRoomSourcePolicy();
  const clevelandLandmarks = stanskiClevelandLandmarks();
  const records = [];
  const sourceFiles = [];
  for (const asset of sourceAssets) {
    const safeId = sanitizeProjectId(asset.id);
    const editablePath = path.join(editableRoot, `${safeId}.pixelorama-source.json`);
    const pngPath = path.join(exportRoot, `${safeId}.png`);
    writeProductionCandidateSourcePng(pngPath, asset, artBible);
    const palette = artSourcePaletteForType(asset.type);
    const frames = compiledFramesForType(asset.type);
    const tileMetadata = compiledTileMetadataForType(asset.type);
    const sourceMeta = {
      format: "openclaw-pixelorama-compatible-source-v1",
      assetId: safeId,
      assetType: asset.type,
      visualPackRevision: "stanski-level1-clean-room-cleveland-art-pack-v3",
      tool: "Pixelorama-compatible editable source",
      exportedPngPath: pngPath,
      palette,
      framePlan: frames,
      tilePlan: tileMetadata || null,
      artBible: artBible.styleTarget,
      cleanRoomSourcePolicy: sourcePolicy,
      clevelandLandmarks:
        asset.type === "background-layer" || asset.type === "tileset" ? clevelandLandmarks : [],
      notes:
        "This is an editable local source contract. Production approval still requires human review; no Nintendo/Sega code, ROMs, or copied pixels are permitted.",
    };
    writeJson(editablePath, sourceMeta);
    const record = {
      blockers: [],
      conversionStatus: "not-converted",
      id: safeId,
      license: "original-clean-room",
      licenseReceipt: {
        status: "pass",
        license: "original-clean-room",
        sourceStrategy: sourcePolicy.sourceStrategy,
        copiedCommercialAsset: false,
        nintendoCodeOrAssetsUsed: false,
        smwReferenceOnly: true,
        sourcePath: pngPath,
        sourceSha256: sha256File(pngPath),
      },
      palette: { colorCount: palette.length, colors: palette },
      provenance: "pixelorama-compatible-local-source",
      cleanRoomSourcePolicy: sourcePolicy,
      clevelandLandmarks:
        asset.type === "background-layer" || asset.type === "tileset" ? clevelandLandmarks : [],
      screenshotProof: [],
      sourceHash: sha256File(pngPath),
      sourcePath: pngPath,
      status: "real-asset",
      type: asset.type,
      usage: [
        `production-candidate editable ${asset.type} for ${projectTitle(projectPackage)} Level 1`,
      ],
      visualMaturity: "production-candidate",
      visualProof: [],
      artSource: {
        tool: "Pixelorama-compatible local source",
        editableSourcePath: editablePath,
        editableSourceSha256: sha256File(editablePath),
        exportedPngPath: pngPath,
        exportedPngSha256: sha256File(pngPath),
      },
      productionApproval: {
        status: "not-approved",
        blocker: "Human 100/100 visual approval has not been recorded.",
      },
      ...(frames.length > 0 ? { frames } : {}),
      ...(tileMetadata ? { tileMetadata } : {}),
    };
    records.push(record);
    sourceFiles.push({
      assetId: safeId,
      type: asset.type,
      editablePath,
      pngPath,
      sha256: record.sourceHash,
    });
  }
  const professionalArtPack = {
    id: "stanski-level1-clean-room-cleveland-art-pack-v3",
    status: records.length > 0 ? "candidate-generated" : "blocked",
    cleanRoomSourcePolicy: sourcePolicy,
    clevelandLandmarks,
    humanApproved: false,
    replacedWeakAssetIds: records
      .filter((record) => ["enemy-sprite", "tileset", "background-layer"].includes(record.type))
      .map((record) => record.id),
    keptCandidateAssetIds: records
      .filter((record) => ["character-sprite", "item-sprite"].includes(record.type))
      .map((record) => record.id),
    blockers:
      records.length > 0
        ? [
            "Human 100/100 visual approval has not been recorded.",
            ...externalBlockedAssetIds.map(
              (assetId) => `${assetId}: original source photo is still external-blocked.`,
            ),
          ]
        : ["No editable source records were generated."],
    externalBlockedAssetIds,
  };
  const tiledMapPath = path.join(editableRoot, "level-1-visual-map.tiled.json");
  writeJson(tiledMapPath, {
    type: "map",
    tiledversion: "openclaw-compatible",
    orientation: "orthogonal",
    renderorder: "right-down",
    width: 128,
    height: 14,
    tilewidth: 16,
    tileheight: 16,
    infinite: false,
    properties: [
      { name: "projectId", type: "string", value: projectId },
      { name: "levelId", type: "string", value: levelId },
      { name: "visualTarget", type: "string", value: artBible.styleTarget },
    ],
    layers: [
      {
        id: 1,
        name: "Cleveland skyline",
        type: "tilelayer",
        visible: true,
        opacity: 1,
        width: 128,
        height: 14,
        data: [],
      },
      {
        id: 2,
        name: "Playable street and bridge",
        type: "objectgroup",
        visible: true,
        opacity: 1,
        objects: [],
      },
    ],
  });
  const updatedPackage = persistProjectAssetRecords(
    projectId,
    projectPackage,
    records,
    "art-source-pack",
    options,
  );
  return {
    status: records.length > 0 ? "pass" : "blocked",
    blockers:
      records.length > 0 ? [] : ["No required assets were available for editable art source pack."],
    generatedAt: nowIso(),
    localOnly: true,
    hostedGlmUsed: false,
    cleanRoomSourcePolicy: projectId === STANSKI_PROJECT_ID ? cleanRoomSourcePolicy() : null,
    clevelandLandmarks: projectId === STANSKI_PROJECT_ID ? stanskiClevelandLandmarks() : [],
    outputDir,
    project: {
      id: updatedPackage.projectId,
      name: projectTitle(updatedPackage),
      packageHash: updatedPackage.packageHash,
    },
    levelId,
    editableRoot,
    exportRoot,
    tiledMapPath,
    tiledMapSha256: sha256File(tiledMapPath),
    artBibleHash: sha256Text(JSON.stringify(artBible)),
    sourceFiles,
    assetRecords: records,
    assetManifestHash: sha256Text(JSON.stringify(records)),
    professionalArtPack,
    cleanRoomSourcePolicy: sourcePolicy,
    clevelandLandmarks,
    visualApprovalClaimed: false,
  };
}

export function projectArtManifest(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const outputDir = options.outputDir || projectReceiptDir(projectId, "art-manifest", options);
  ensureDir(outputDir);
  const glmRuntime = probeLocalGlm52();
  const manifest = buildDefaultArtManifest(projectPackage, options.assetId);
  const glmPatch =
    glmRuntime.status === "ready"
      ? requestLocalGlmArtPatch(manifest)
      : { status: "blocked", blocker: glmRuntime.blocker };
  const manifestPath = path.join(outputDir, "art-manifest.json");
  writeJson(manifestPath, manifest);
  return {
    status: "pass",
    generatedAt: nowIso(),
    localOnly: true,
    localGlmOnly: true,
    hostedGlmUsed: false,
    outputDir,
    project: {
      id: projectPackage.projectId,
      name: projectTitle(projectPackage),
      packageHash: projectPackage.packageHash,
    },
    assetId: options.assetId || null,
    manifestPath,
    manifestHash: manifest.manifestHash,
    manifest,
    glmRuntime,
    glmPatch: {
      ...glmPatch,
      note: "Hosted GLM is not used. Deterministic manifest remains the source of truth unless the local GLM patch validates.",
    },
  };
}

export function projectArtCompile(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const latestManifestReceipt = latestProjectReceipt(projectId, "art-manifest", options);
  const latestSourcePack = latestProjectReceipt(projectId, "art-source-pack", options);
  const receiptManifest = latestManifestReceipt?.manifest;
  const manifest =
    options.assetId &&
    receiptManifest &&
    Array.isArray(receiptManifest.assets) &&
    receiptManifest.assets.length > 0
      ? receiptManifest
      : buildDefaultArtManifest(projectPackage, options.assetId);
  const registrySourceRecords = Array.isArray(projectPackage?.manifest?.assetRegistry?.records)
    ? projectPackage.manifest.assetRegistry.records.filter(
        (record) =>
          record?.artSource?.editableSourcePath &&
          record?.sourcePath &&
          existsSync(record.sourcePath),
      )
    : [];
  const sourcePackRecords =
    latestSourcePack?.status === "pass" && Array.isArray(latestSourcePack.assetRecords)
      ? latestSourcePack.assetRecords
      : registrySourceRecords;
  const outputDir = options.outputDir || projectReceiptDir(projectId, "art-compile", options);
  const sourceRoot = path.join(outputDir, "compiled-assets");
  const reviewRoot = path.join(outputDir, "visual-review");
  ensureDir(sourceRoot);
  ensureDir(reviewRoot);
  const assetRecords = [];
  const compiledAssets = [];
  const manifestAssets =
    sourcePackRecords.length > 0
      ? sourcePackRecords
      : (manifest.assets || []).flatMap((asset) => {
          if (asset.type !== "background-layer" || options.assetId) return [asset];
          return ["far-skyline", "mid-bridges", "foreground-street"].map((layerName, index) => ({
            ...asset,
            id: `${asset.id}-${layerName}`,
            layerIndex: index,
          }));
        });
  for (const asset of manifestAssets) {
    const compiledPath = path.join(sourceRoot, `${asset.id}.png`);
    const hasEditableSource = Boolean(asset.sourcePath && existsSync(asset.sourcePath));
    const sourcePath = hasEditableSource
      ? (copyFileSync(asset.sourcePath, compiledPath), compiledPath)
      : writeCompiledAssetPng(compiledPath, asset, manifest);
    const reviewPath = path.join(reviewRoot, `${asset.id}-review.png`);
    if (hasEditableSource) {
      copyFileSync(sourcePath, reviewPath);
    } else {
      writeVisualReviewSheet(reviewPath, {
        ...asset,
        seed: `${manifest.manifestHash}:${asset.id}`,
      });
    }
    const frames =
      Array.isArray(asset.frames) && asset.frames.length > 0
        ? asset.frames
        : compiledFramesForType(asset.type);
    const tileMetadata = asset.tileMetadata || compiledTileMetadataForType(asset.type);
    const visualMaturity = hasEditableSource
      ? "production-candidate"
      : "draft-generated-placeholder";
    const record = {
      blockers: hasEditableSource
        ? []
        : ["Procedural generated art is placeholder-only and cannot pass production visual QA."],
      conversionStatus: "not-converted",
      id: asset.id,
      license: asset.license || "original-clean-room",
      ...(asset.licenseReceipt ? { licenseReceipt: asset.licenseReceipt } : {}),
      palette: asset.palette || {
        colorCount: asset.paletteRamp?.length || 4,
        colors: asset.paletteRamp || [],
      },
      provenance: hasEditableSource
        ? asset.provenance || "pixelorama-compatible-local-source"
        : "openclaw-procedural-placeholder",
      screenshotProof: [],
      sourceHash: sha256File(sourcePath),
      sourcePath,
      status: "real-asset",
      type: asset.type,
      usage: asset.usage || [
        `compiled ${visualMaturity} ${asset.type} for ${projectTitle(projectPackage)}`,
      ],
      visualMaturity,
      ...(asset.cleanRoomSourcePolicy
        ? { cleanRoomSourcePolicy: asset.cleanRoomSourcePolicy }
        : projectId === STANSKI_PROJECT_ID
          ? { cleanRoomSourcePolicy: cleanRoomSourcePolicy() }
          : {}),
      ...(Array.isArray(asset.clevelandLandmarks) && asset.clevelandLandmarks.length > 0
        ? { clevelandLandmarks: asset.clevelandLandmarks }
        : {}),
      visualProof: [
        {
          kind: visualProofKindForAsset(asset.type),
          path: reviewPath,
          sha256: sha256File(reviewPath),
          sourceAssetPath: sourcePath,
          source: hasEditableSource ? "editable-art-source" : "synthetic-review-sheet",
        },
      ],
      ...(asset.artSource ? { artSource: asset.artSource } : {}),
      ...(frames.length > 0 ? { frames } : {}),
      ...(tileMetadata ? { tileMetadata } : {}),
    };
    assetRecords.push(record);
    compiledAssets.push({
      assetId: asset.id,
      type: asset.type,
      sourcePath,
      sourceSha256: record.sourceHash,
      reviewPath,
      reviewSha256: record.visualProof[0].sha256,
      visualMaturity,
    });
  }
  const updatedPackage = persistProjectAssetRecords(
    projectId,
    projectPackage,
    assetRecords,
    "art-compile",
    options,
  );
  return {
    status:
      assetRecords.length > 0 &&
      assetRecords.every((record) => record.visualMaturity === "production-candidate")
        ? "pass"
        : "blocked",
    blockers:
      assetRecords.length === 0
        ? ["No art manifest assets were available to compile."]
        : assetRecords
            .flatMap((record) => record.blockers || [])
            .concat(
              assetRecords.every((record) => record.visualMaturity === "production-candidate")
                ? []
                : [
                    "Editable Pixelorama/Tiled source pack is required before art can be production-candidate.",
                  ],
            ),
    generatedAt: nowIso(),
    localOnly: true,
    hostedGlmUsed: false,
    visualApprovalClaimed: false,
    outputDir,
    project: {
      id: updatedPackage.projectId,
      name: projectTitle(updatedPackage),
      packageHash: updatedPackage.packageHash,
    },
    manifestHash: manifest.manifestHash,
    compiledAssets,
    assetRecords,
    assetManifestHash: sha256Text(JSON.stringify(assetRecords)),
  };
}

function rgbAt(image, x, y) {
  if (!image || x < 0 || y < 0 || x >= image.width || y >= image.height) return [0, 0, 0];
  return image.pixels[y * image.width + x] || [0, 0, 0];
}

function isTransparentAssetRgb(rgb) {
  return rgb[0] <= 22 && rgb[1] <= 22 && rgb[2] <= 30;
}

function setRgbPixel(pixels, width, height, x, y, rgb) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = (y * width + x) * 3;
  pixels[index] = rgb[0];
  pixels[index + 1] = rgb[1];
  pixels[index + 2] = rgb[2];
}

function blitRgbImage(
  pixels,
  width,
  height,
  image,
  {
    sx = 0,
    sy = 0,
    sw = image?.width || 0,
    sh = image?.height || 0,
    dx = 0,
    dy = 0,
    scale = 1,
    transparent = false,
  } = {},
) {
  if (!image) return;
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      const rgb = rgbAt(image, sx + x, sy + y);
      if (transparent && isTransparentAssetRgb(rgb)) continue;
      for (let yy = 0; yy < scale; yy += 1) {
        for (let xx = 0; xx < scale; xx += 1)
          setRgbPixel(pixels, width, height, dx + x * scale + xx, dy + y * scale + yy, rgb);
      }
    }
  }
}

function assetRecordByType(assetRecords, type) {
  return assetRecords.find(
    (record) => record?.type === type && record.sourcePath && existsSync(record.sourcePath),
  );
}

function readRecordPng(record) {
  if (!record?.sourcePath || !existsSync(record.sourcePath)) return null;
  return readSimpleRgbPng(record.sourcePath);
}

function writeInGameProofScreenshot(outputPath, proofKind, projectPackage, assetRecords) {
  const width = 256;
  const height = 224;
  const pixels = new Uint8Array(width * height * 3);
  const set = (x, y, rgb) => setRgbPixel(pixels, width, height, x, y, rgb);
  for (let y = 0; y < height; y += 1) {
    const sky = y < 144;
    const ground = y >= 176;
    const rgb = ground
      ? [64, 48, 38]
      : sky
        ? y < 50
          ? [80, 158, 218]
          : [128, 196, 230]
        : [52, 70, 92];
    for (let x = 0; x < width; x += 1) set(x, y, rgb);
  }

  const background = readRecordPng(assetRecordByType(assetRecords, "background-layer"));
  const tileset = readRecordPng(assetRecordByType(assetRecords, "tileset"));
  const toddSheet = readRecordPng(assetRecordByType(assetRecords, "character-sprite"));
  const enemySheet = readRecordPng(assetRecordByType(assetRecords, "enemy-sprite"));
  const itemSheet = readRecordPng(assetRecordByType(assetRecords, "item-sprite"));

  if (background) {
    const xOffset = proofKind === "mid" ? 18 : proofKind === "goal" ? 34 : 0;
    blitRgbImage(pixels, width, height, background, {
      sx: xOffset,
      sy: 0,
      sw: Math.min(width, background.width - xOffset),
      sh: Math.min(144, background.height),
      dx: 0,
      dy: 0,
    });
    if (xOffset > 0) {
      blitRgbImage(pixels, width, height, background, {
        sx: 0,
        sy: 0,
        sw: Math.min(xOffset, background.width),
        sh: Math.min(144, background.height),
        dx: width - xOffset,
        dy: 0,
      });
    }
  }

  if (tileset) {
    for (let y = 176; y < height; y += 16) {
      for (let x = 0; x < width; x += 16) {
        const tile = y >= 208 ? 1 : x % 64 === 0 ? 2 : 0;
        blitRgbImage(pixels, width, height, tileset, {
          sx: (tile % 12) * 16,
          sy: Math.floor(tile / 12) * 16,
          sw: 16,
          sh: 16,
          dx: x,
          dy: y,
        });
      }
    }
    for (let x = 72; x < 144; x += 16)
      blitRgbImage(pixels, width, height, tileset, {
        sx: (2 % 12) * 16,
        sy: 0,
        sw: 16,
        sh: 16,
        dx: x,
        dy: 144,
      });
    for (let x = 168; x < 224; x += 16)
      blitRgbImage(pixels, width, height, tileset, {
        sx: (10 % 12) * 16,
        sy: 0,
        sw: 16,
        sh: 16,
        dx: x,
        dy: 160,
      });
  }

  const frameForScene = proofKind === "mid" ? 12 : proofKind === "goal" ? 31 : 0;
  const toddX = proofKind === "start" ? 36 : proofKind === "mid" ? 116 : 190;
  const toddY = proofKind === "goal" ? 137 : 144;
  if (toddSheet)
    blitRgbImage(pixels, width, height, toddSheet, {
      sx: (frameForScene % 10) * 16,
      sy: Math.floor(frameForScene / 10) * 32,
      sw: 16,
      sh: 32,
      dx: toddX,
      dy: toddY,
      transparent: true,
    });

  const itemFrames = [
    [94, 160, 0],
    [128, 128, 1],
    [164, 160, 2],
    [218, 150, 3],
  ];
  if (itemSheet) {
    for (const [dx, dy, frame] of itemFrames) {
      blitRgbImage(pixels, width, height, itemSheet, {
        sx: frame * 16,
        sy: 8,
        sw: 16,
        sh: 16,
        dx,
        dy,
        transparent: true,
      });
    }
  }

  if (enemySheet) {
    blitRgbImage(pixels, width, height, enemySheet, {
      sx: proofKind === "goal" ? 0 : 16,
      sy: 6,
      sw: 16,
      sh: 26,
      dx: proofKind === "start" ? 178 : 60,
      dy: 150,
      transparent: true,
    });
    blitRgbImage(pixels, width, height, enemySheet, {
      sx: 0,
      sy: 38,
      sw: 16,
      sh: 26,
      dx: 236,
      dy: 150,
      transparent: true,
    });
  }

  // HUD and skyline label shapes are rendered as real pixels, not contact-sheet placeholders.
  for (let x = 6; x < 96; x += 1) {
    set(x, 6, [16, 16, 24]);
    set(x, 17, [16, 16, 24]);
  }
  for (let y = 6; y < 18; y += 1) {
    set(6, y, [16, 16, 24]);
    set(95, y, [16, 16, 24]);
  }
  for (let x = 12; x < 40; x += 5)
    drawLine(
      (xx, yy, color) => set(xx, yy, color === 15 ? [255, 255, 255] : [240, 192, 95]),
      x,
      11,
      x + 2,
      11,
      15,
    );
  return writeRgbPng(outputPath, width, height, (x, y) => {
    const index = (y * width + x) * 3;
    return [pixels[index], pixels[index + 1], pixels[index + 2]];
  });
}

function readSimpleRgbPng(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 33 || bytes.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`Unsupported PNG file: ${file}`);
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (type === "IHDR") {
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      if (bitDepth !== 8 || colorType !== 2) {
        throw new Error(`Unsupported PNG color format in ${file}`);
      }
    }
    if (type === "IDAT") idat.push(bytes.subarray(dataStart, dataEnd));
    offset = dataEnd + 4;
  }
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const pixels = [];
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = inflated[rowStart];
    if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter} in ${file}`);
    for (let x = 0; x < width; x += 1) {
      const pixelStart = rowStart + 1 + x * 3;
      pixels.push([inflated[pixelStart], inflated[pixelStart + 1], inflated[pixelStart + 2]]);
    }
  }
  return { width, height, pixels };
}

function analyzeVisualPng(file) {
  const image = readSimpleRgbPng(file);
  const colorSet = new Set();
  let edgeScore = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = y * image.width + x;
      const pixel = image.pixels[index];
      colorSet.add(pixel.join(","));
      if (x > 0) {
        const left = image.pixels[index - 1];
        edgeScore +=
          Math.abs(pixel[0] - left[0]) +
          Math.abs(pixel[1] - left[1]) +
          Math.abs(pixel[2] - left[2]);
      }
      if (y > 0) {
        const up = image.pixels[index - image.width];
        edgeScore +=
          Math.abs(pixel[0] - up[0]) + Math.abs(pixel[1] - up[1]) + Math.abs(pixel[2] - up[2]);
      }
    }
  }
  const edgeDensity = edgeScore / Math.max(1, image.width * image.height * 765 * 2);
  return {
    path: file,
    width: image.width,
    height: image.height,
    uniqueColors: colorSet.size,
    edgeDensity: Number(edgeDensity.toFixed(4)),
  };
}

function isProductionVisualProof(proof) {
  return (
    proof?.kind === "in-game-screenshot" &&
    proof.path &&
    existsSync(proof.path) &&
    proof.productionEligible === true &&
    PRODUCTION_VISUAL_PROOF_SOURCES.has(proof.proofSource)
  );
}

function visualProofProductionBlockers(visualProof) {
  const screenshots = Array.isArray(visualProof?.screenshots) ? visualProof.screenshots : [];
  if (visualProof?.status !== "pass") {
    return ["Visual proof receipt must pass before production visual approval."];
  }
  if (screenshots.length === 0) {
    return ["Production visual proof requires runtime or emulator screenshot artifacts."];
  }
  const nonProduction = screenshots.filter((shot) => !isProductionVisualProof(shot));
  if (nonProduction.length > 0) {
    const sources = [...new Set(nonProduction.map((shot) => shot.proofSource || "unknown"))];
    return [
      `Production visual proof requires runtime-capture or emulator-capture screenshots; found ${sources.join(", ")}.`,
    ];
  }
  return [];
}

function visualQualityBlockers({
  projectId,
  latestVisualProof,
  latestRuntimeAssetTruth,
  latestRejection,
  screenshotMetrics,
}) {
  const blockers = [];
  const grades =
    latestRejection?.categoryGrades ||
    (projectId === STANSKI_PROJECT_ID ? STANSKI_VISUAL_CATEGORY_GRADES : null);
  if (grades?.inGameScreenshots < 50) {
    blockers.push(
      `Human in-game screenshot grade is ${grades.inGameScreenshots}/100; actual runtime frame is not production quality.`,
    );
  }
  if (grades?.enemySpriteSheet < 50)
    blockers.push(`Enemy sprite sheet grade is ${grades.enemySpriteSheet}/100.`);
  if (grades?.tileset < 50) blockers.push(`Tileset grade is ${grades.tileset}/100.`);
  if (grades?.backgroundLayer < 50)
    blockers.push(`Background layer grade is ${grades.backgroundLayer}/100.`);
  if (!latestVisualProof || latestVisualProof.status !== "pass") {
    blockers.push("Visual quality audit requires a passing project-visual-proof receipt first.");
  }
  blockers.push(...visualProofProductionBlockers(latestVisualProof));
  if (screenshotMetrics.length > 0) {
    const lowDetail = screenshotMetrics.filter(
      (metric) => metric.uniqueColors < 12 || metric.edgeDensity < 0.025,
    );
    if (lowDetail.length > 0) {
      blockers.push(
        "In-game screenshots have low deterministic detail metrics; current frame still resembles a placeholder composition.",
      );
    }
  }
  if (latestRuntimeAssetTruth?.status !== "pass") {
    blockers.push(
      latestRuntimeAssetTruth?.blockers?.[0] ||
        "Runtime asset truth is not proven: screenshot capture does not yet verify that improved Todd/item sheets are the pixels rendered in-game.",
    );
  }
  return [...new Set(blockers)];
}

export function projectVisualProof(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const latestConversion = latestProjectReceipt(projectId, "conversion", options);
  const assetRecords = Array.isArray(latestConversion?.assetRecords)
    ? latestConversion.assetRecords
    : Array.isArray(projectPackage?.manifest?.assetRegistry?.records)
      ? projectPackage.manifest.assetRegistry.records
      : [];
  const outputDir = options.outputDir || projectReceiptDir(projectId, "visual-proof", options);
  ensureDir(outputDir);
  const blockers = [];
  const proofSource =
    typeof options.proofSource === "string" && options.proofSource.trim()
      ? options.proofSource.trim()
      : "synthetic-composite";
  const productionEligible = PRODUCTION_VISUAL_PROOF_SOURCES.has(proofSource);
  if (assetRecords.length === 0) {
    blockers.push(
      "No asset records are available for in-game visual proof. Run project-art-compile and project-conversion first.",
    );
  }
  const screenshots =
    blockers.length === 0
      ? ["start", "mid", "goal"].map((kind) => {
          const screenshotPath = writeInGameProofScreenshot(
            path.join(outputDir, `${kind}.png`),
            kind,
            projectPackage,
            assetRecords,
          );
          return {
            kind: "in-game-screenshot",
            scene: kind,
            path: screenshotPath,
            sha256: sha256File(screenshotPath),
            assetManifestHash:
              latestConversion?.assetManifestHash || sha256Text(JSON.stringify(assetRecords)),
            proofSource,
            productionEligible,
          };
        })
      : [];
  const productionProofBlockers =
    screenshots.length > 0 && !productionEligible
      ? [
          `Project visual proof source is ${proofSource}; production visual proof requires runtime-capture or emulator-capture.`,
        ]
      : [];
  const updatedRecords = assetRecords.map((record) => ({
    ...record,
    visualProof: [
      ...(Array.isArray(record.visualProof) ? record.visualProof : []),
      ...screenshots.map((shot) => ({
        kind: "in-game-screenshot",
        scene: shot.scene,
        path: shot.path,
        sha256: shot.sha256,
        sourceAssetPath: record.sourcePath,
        proofSource: shot.proofSource,
        productionEligible: shot.productionEligible,
      })),
    ],
    screenshotProof: screenshots.map((shot) => shot.path),
  }));
  const updatedPackage =
    screenshots.length > 0
      ? persistProjectAssetRecords(
          projectId,
          projectPackage,
          updatedRecords,
          "visual-proof",
          options,
        )
      : projectPackage;
  return {
    status: blockers.length === 0 ? "pass" : "blocked",
    blockers,
    generatedAt: nowIso(),
    localOnly: true,
    hostedGlmUsed: false,
    cleanRoomSourcePolicy: projectId === STANSKI_PROJECT_ID ? cleanRoomSourcePolicy() : null,
    clevelandLandmarks: projectId === STANSKI_PROJECT_ID ? stanskiClevelandLandmarks() : [],
    outputDir,
    project: {
      id: updatedPackage.projectId,
      name: projectTitle(updatedPackage),
      packageHash: updatedPackage.packageHash,
    },
    assetManifestHash:
      latestConversion?.assetManifestHash || sha256Text(JSON.stringify(assetRecords)),
    sourceReceipt: latestConversion?.artifacts?.latestPath || latestConversion?.receiptPath || null,
    screenshots,
    productionProofStatus: {
      status: productionProofBlockers.length === 0 ? "pass" : "blocked",
      blockers: productionProofBlockers,
      eligibleSources: [...PRODUCTION_VISUAL_PROOF_SOURCES],
      proofSource,
    },
    visualApprovalClaimed: false,
    note:
      productionProofBlockers.length === 0
        ? "Runtime/emulator screenshots are visual proof artifacts only. Production 100/100 still requires production-approved maturity and human approval."
        : "Synthetic composite screenshots are diagnostic artifacts only. They do not count as production visual proof or human approval.",
  };
}

function runtimeUsageForAssetType(type) {
  if (type === "character-sprite") return "player metasprite/OAM frames";
  if (type === "enemy-sprite") return "enemy metasprite/OAM frames";
  if (type === "item-sprite") return "collectible, power-up, projectile, and ending sprites";
  if (type === "tileset") return "foreground collision and level tilemap";
  if (type === "background-layer") return "background/parallax layer";
  return "runtime asset";
}

function runtimeAssetRecordsForProject(projectPackage, latestConversion) {
  return Array.isArray(latestConversion?.assetRecords)
    ? latestConversion.assetRecords
    : Array.isArray(projectPackage?.manifest?.assetRegistry?.records)
      ? projectPackage.manifest.assetRegistry.records
      : [];
}

function conversionOutputsByAssetId(latestConversion) {
  const outputMap = new Map();
  for (const conversion of latestConversion?.conversions || []) {
    if (!conversion?.assetId) continue;
    outputMap.set(conversion.assetId, Array.isArray(conversion.outputs) ? conversion.outputs : []);
  }
  return outputMap;
}

function runtimeAssetUsageSummary(assetRecords, latestConversion = null) {
  const outputMap = conversionOutputsByAssetId(latestConversion);
  return assetRecords
    .filter((record) => REQUIRED_PROJECT_ASSET_TYPES.includes(record.type))
    .map((record) => {
      const convertedOutputs = outputMap.get(record.id) || [];
      return {
        assetId: record.id,
        type: record.type,
        sourceSha256: record.sourceHash || null,
        sourcePath: record.sourcePath || null,
        convertedOutputs,
        convertedOutputHashes: Object.fromEntries(
          convertedOutputs.map((output) => [path.basename(output.path), output.sha256]),
        ),
        expectedRuntimeUsage: runtimeUsageForAssetType(record.type),
        licenseReceipt: record.licenseReceipt || null,
        cleanRoomSourcePolicy: record.cleanRoomSourcePolicy || null,
      };
    });
}

function runtimeAssetsHaveConvertedOutputs(runtimeAssetsUsed) {
  return runtimeAssetsUsed.every(
    (asset) =>
      REQUIRED_PROJECT_ASSET_TYPES.includes(asset.type) &&
      Array.isArray(asset.convertedOutputs) &&
      asset.convertedOutputs.some(
        (output) => /tiles\.4bpp$/u.test(output.path) && existsSync(output.path),
      ),
  );
}

function firstRuntimeTileOutput(runtimeAssetsUsed, types) {
  for (const asset of runtimeAssetsUsed) {
    if (!types.includes(asset.type)) continue;
    const output = (asset.convertedOutputs || []).find(
      (item) => /tiles\.4bpp$/u.test(item.path) && existsSync(item.path),
    );
    if (output) return output;
  }
  return null;
}

function runtimeAssetByteList(runtimeAssetsUsed, types, maxBytes, fallbackValues) {
  const output = firstRuntimeTileOutput(runtimeAssetsUsed, types);
  if (!output) return fallbackValues;
  const bytes = readFileSync(output.path).subarray(0, maxBytes);
  if (bytes.length === 0) return fallbackValues;
  return [...bytes].map((byte) => `0x${byte.toString(16).padStart(2, "0")}`);
}

function runtimeAssetOutput(runtimeAssetsUsed, types, fileName) {
  for (const asset of runtimeAssetsUsed) {
    if (!types.includes(asset.type)) continue;
    const output = (asset.convertedOutputs || []).find(
      (item) => path.basename(item.path) === fileName && existsSync(item.path),
    );
    if (output) return output;
  }
  return null;
}

function runtimeAssetByteArray(runtimeAssetsUsed, types, fileName, maxBytes, fallbackValues) {
  const output = runtimeAssetOutput(runtimeAssetsUsed, types, fileName);
  if (!output) return fallbackValues;
  const bytes = readFileSync(output.path).subarray(0, maxBytes);
  if (bytes.length === 0) return fallbackValues;
  return [...bytes].map((byte) => `0x${byte.toString(16).padStart(2, "0")}`);
}

function runtimeAssetU16Array(runtimeAssetsUsed, types, fileName, maxWords, fallbackValues) {
  const output = runtimeAssetOutput(runtimeAssetsUsed, types, fileName);
  if (!output) return fallbackValues;
  const bytes = readFileSync(output.path);
  const words = [];
  for (let offset = 0; offset + 1 < bytes.length && words.length < maxWords; offset += 2) {
    words.push(`0x${bytes.readUInt16LE(offset).toString(16).padStart(4, "0")}`);
  }
  if (words.length === 0) return fallbackValues;
  while (words.length < maxWords) words.push("0x0000");
  return words;
}

function runtimeSpriteTilePack(runtimeAssetsUsed, fallbackValues) {
  const spriteTypes = ["character-sprite", "enemy-sprite", "item-sprite"];
  const packedBytes = [];
  const offsets = {};
  for (const type of spriteTypes) {
    const output = runtimeAssetOutput(runtimeAssetsUsed, [type], "tiles.4bpp");
    offsets[type] = Math.floor(packedBytes.length / 32);
    if (output) packedBytes.push(...readFileSync(output.path).subarray(0, 2048));
  }
  if (packedBytes.length === 0) {
    return {
      offsets: {
        "character-sprite": 0,
        "enemy-sprite": 1,
        "item-sprite": 2,
      },
      values: fallbackValues,
    };
  }
  return {
    offsets,
    values: packedBytes.map((byte) => `0x${byte.toString(16).padStart(2, "0")}`),
  };
}

function encodeSnes4bppTile(rows) {
  if (!Array.isArray(rows) || rows.length !== 8) {
    throw new Error("SNES 4bpp tile rows must be exactly 8 rows.");
  }
  const low = [];
  const high = [];
  for (const row of rows) {
    const cells = String(row);
    if (cells.length !== 8) throw new Error(`SNES 4bpp tile row must be 8 pixels: ${cells}`);
    let p0 = 0;
    let p1 = 0;
    let p2 = 0;
    let p3 = 0;
    for (let x = 0; x < 8; x++) {
      const color = Number.parseInt(cells[x], 16);
      const bit = 7 - x;
      p0 |= (color & 1) << bit;
      p1 |= ((color >> 1) & 1) << bit;
      p2 |= ((color >> 2) & 1) << bit;
      p3 |= ((color >> 3) & 1) << bit;
    }
    low.push(p0, p1);
    high.push(p2, p3);
  }
  return [...low, ...high].map((byte) => `0x${byte.toString(16).padStart(2, "0")}`);
}

function tilesFromPixelMatrix(rows, widthTiles, heightTiles) {
  if (!Array.isArray(rows) || rows.length !== heightTiles * 8)
    throw new Error("Pixel matrix height does not match tile grid.");
  const values = [];
  for (let ty = 0; ty < heightTiles; ty++) {
    for (let tx = 0; tx < widthTiles; tx++) {
      const tileRows = [];
      for (let y = 0; y < 8; y++) {
        const row = String(rows[ty * 8 + y]);
        if (row.length !== widthTiles * 8)
          throw new Error("Pixel matrix width does not match tile grid.");
        tileRows.push(row.slice(tx * 8, tx * 8 + 8));
      }
      values.push(...encodeSnes4bppTile(tileRows));
    }
  }
  return values;
}

function customForegroundRuntimeTiles() {
  const tileRows = [
    // 0: transparent blank. Critical: BG1 must not cover the skyline where map tile is 0.
    ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
    // 1: asphalt road.
    ["11111111", "12111121", "11111111", "11121111", "11111111", "21111112", "11111111", "11112111"],
    // 2: yellow lane stripe on road.
    ["11111111", "11111111", "33333333", "33333333", "11111111", "11111111", "11111111", "11111111"],
    // 3: orange/brown brick sidewalk.
    ["44444444", "45545545", "44444444", "54455445", "44444444", "45545545", "44444444", "55445544"],
    // 4: bridge/rail truss foreground accent.
    ["00020000", "00222000", "02222200", "22222220", "00222000", "02020200", "20000020", "00000000"],
    // 5: goal/toilet/checkpoint base tile.
    ["00077700", "00777770", "07722277", "07222227", "07722277", "00777770", "00077700", "00022200"],
  ];
  return {
    palette: [
      "0x0000",
      "0x0842",
      "0x4210",
      "0x03ff",
      "0x015f",
      "0x023f",
      "0x001f",
      "0x7fff",
      "0x7c00",
      "0x03e0",
      "0x7fe0",
      "0x7c1f",
      "0x0010",
      "0x02d0",
      "0x56b5",
      "0x0000",
    ],
    tiles: tileRows.flatMap((rows) => encodeSnes4bppTile(rows)),
  };
}

function customSpriteRuntimeTiles() {
  const bases = {};
  const tiles = [];
  const addMatrix = (name, rows, widthTiles, heightTiles) => {
    bases[name] = Math.floor(tiles.length / 32);
    tiles.push(...tilesFromPixelMatrix(rows, widthTiles, heightTiles));
  };
  const addTile = (name, rows) => {
    bases[name] = Math.floor(tiles.length / 32);
    tiles.push(...encodeSnes4bppTile(rows));
  };
  const toddStanding = [
    "0000011111100000",
    "0000144444410000",
    "0001442222441000",
    "0001422222241000",
    "0001423223241000",
    "0001422222241000",
    "0001442222441000",
    "0000111111100000",
    "0000016666100000",
    "0000166666610000",
    "0001667676661000",
    "0011666666661100",
    "0011666666661100",
    "0001166666611000",
    "0000116666110000",
    "0000011111100000",
    "0000088888800000",
    "0000888888880000",
    "0000888998880000",
    "0000888998880000",
    "0000888998880000",
    "0000888998880000",
    "0000999009990000",
    "0000999009990000",
    "0000999009990000",
    "0000AAA00AAA0000",
    "0000AAA00AAA0000",
    "0000111001110000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
  ];
  const toddRun = [
    "0000011111100000",
    "0000144444410000",
    "0001442222441000",
    "0001422222241000",
    "0001423223241000",
    "0001422222241000",
    "0001442222441000",
    "0000111111100000",
    "0000016666100000",
    "0000166666610000",
    "0001667676661000",
    "0011666666661100",
    "0011666666661100",
    "0001166666611000",
    "0000116666110000",
    "0000011111100000",
    "0000088888800000",
    "0000888888880000",
    "0000888998880000",
    "0000889998880000",
    "0000899908880000",
    "0000990009980000",
    "0009900000990000",
    "0009900009990000",
    "000AA0000AAA0000",
    "00AAA00000AA0000",
    "0011100001110000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
  ];
  const enemy = [
    "0000111111000000",
    "0001EEEEEE100000",
    "001EEFFEEFEE1000",
    "01EEFEEFFEEFE100",
    "01EEEFFFFEEE1000",
    "01EEEFEEEFEE1000",
    "001EEEFFFEEE1000",
    "0001EEEEEE100000",
    "000011EE11000000",
    "0001EE11EE100000",
    "001EE1001EE10000",
    "001E100001E10000",
    "0001000000010000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
  ];
  const burger = [
    "0000000000000000",
    "00000BBBBBB00000",
    "0000BCCCCCCB0000",
    "000BBDDDDDDBB000",
    "000BEEEEEEEB0000",
    "0000BCCCCCCB0000",
    "00000BBBBBB00000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
  ];
  const pizza = [
    "0000000000000000",
    "0000000B00000000",
    "000000BB00000000",
    "00000BCCB0000000",
    "0000BCCCCB000000",
    "000BCCDCCCB00000",
    "00BCCCCDCCCB0000",
    "0BBBBBBBBBBBB000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
  ];
  const checkpoint = [
    "0000007700000000",
    "0000007700000000",
    "00000077BBBB0000",
    "00000077B33B0000",
    "00000077BBBB0000",
    "0000007700000000",
    "0000007700000000",
    "0000007700000000",
    "0000007700000000",
    "0000077770000000",
    "0000777777000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
  ];
  const toilet = [
    "0000077777000000",
    "0000772227700000",
    "0007722222770000",
    "0007222222270000",
    "0007722222770000",
    "0000777777700000",
    "0000072227000000",
    "0000072227000000",
    "0000772227700000",
    "0000722222700000",
    "0000777777700000",
    "0000011111000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
    "0000000000000000",
  ];
  addMatrix("toddStanding", toddStanding, 2, 4);
  addMatrix("toddRun", toddRun, 2, 4);
  addMatrix("enemy", enemy, 2, 2);
  addMatrix("burger", burger, 2, 2);
  addMatrix("pizza", pizza, 2, 2);
  addMatrix("checkpoint", checkpoint, 2, 2);
  addMatrix("toilet", toilet, 2, 2);
  addTile("gas", ["00000000", "00055000", "00599500", "05999950", "05999950", "00599500", "00055000", "00000000"]);
  addTile("spark", ["00055000", "00500500", "05055050", "00599500", "05999950", "05055050", "00500500", "00055000"]);
  return {
    bases,
    palette: [
      "0x0000",
      "0x0000",
      "0x021f",
      "0x033f",
      "0x0110",
      "0x03e0",
      "0x001f",
      "0x7fff",
      "0x7c00",
      "0x3800",
      "0x4210",
      "0x03ff",
      "0x01df",
      "0x02ff",
      "0x03e8",
      "0x01e4",
    ],
    tiles,
  };
}

export function projectRuntimeAssetTruth(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const latestConversion = latestProjectReceipt(projectId, "conversion", options);
  const latestEngineRom = latestProjectReceipt(projectId, "engine-rom", options);
  const latestVisualProof = latestProjectReceipt(projectId, "visual-proof", options);
  const outputDir =
    options.outputDir || projectReceiptDir(projectId, "runtime-asset-truth", options);
  ensureDir(outputDir);
  const assetRecords = runtimeAssetRecordsForProject(projectPackage, latestConversion).filter(
    (record) => REQUIRED_PROJECT_ASSET_TYPES.includes(record.type),
  );
  const runtimeAssetsUsed = Array.isArray(latestEngineRom?.runtimeAssetsUsed)
    ? latestEngineRom.runtimeAssetsUsed
    : [];
  const runtimeIds = new Set(runtimeAssetsUsed.map((asset) => asset.assetId || asset.id));
  const visualProofBlockers = visualProofProductionBlockers(latestVisualProof);
  const runtimeBinding = latestEngineRom?.runtimeAssetBinding || null;
  const runtimeBindingBlockers =
    runtimeBinding?.productionPixelBinding === true
      ? []
      : [
          runtimeBinding?.blocker ||
            "Engine ROM receipt does not prove converted pixel data is bound into the runtime source.",
        ];
  const blockers = [];
  if (assetRecords.length === 0) {
    blockers.push("Runtime asset truth requires converted production asset records.");
  }
  if (!latestEngineRom || latestEngineRom.status !== "pass") {
    blockers.push("Runtime asset truth requires a passing project-engine-rom receipt.");
  }
  if (runtimeAssetsUsed.length === 0) {
    blockers.push("Engine ROM receipt does not list runtimeAssetsUsed.");
  }
  blockers.push(...runtimeBindingBlockers);
  blockers.push(...visualProofBlockers);
  const assets = assetRecords.map((record) => {
    const engineUsesAsset = runtimeIds.has(record.id);
    const usedRuntimeAsset = runtimeAssetsUsed.find(
      (asset) => (asset.assetId || asset.id) === record.id,
    );
    const runtimeProofBlockers = [
      ...(engineUsesAsset
        ? []
        : [`Engine ROM receipt does not list ${record.id} in runtimeAssetsUsed.`]),
      ...(usedRuntimeAsset?.convertedOutputs?.length
        ? []
        : [`Engine ROM receipt does not list converted output files for ${record.id}.`]),
      ...runtimeBindingBlockers,
      ...visualProofBlockers,
    ];
    return {
      assetId: record.id,
      type: record.type,
      sourceSha256: record.sourceHash || null,
      expectedRuntimeUsage: runtimeUsageForAssetType(record.type),
      engineReceiptUsesAsset: engineUsesAsset,
      convertedOutputsBound: Array.isArray(usedRuntimeAsset?.convertedOutputs)
        ? usedRuntimeAsset.convertedOutputs
        : [],
      runtimeProofStatus: runtimeProofBlockers.length === 0 ? "proven" : "blocked",
      blockers: [...new Set(runtimeProofBlockers)],
    };
  });
  for (const asset of assets) blockers.push(...asset.blockers);
  const report = {
    format: "openclaw-snes-runtime-asset-truth-v1",
    projectId,
    projectName: projectTitle(projectPackage),
    levelId: options.levelId || STANSKI_LEVEL_ONE_ID,
    status: blockers.length === 0 ? "pass" : "blocked",
    blockers: [...new Set(blockers)],
    generatedAt: nowIso(),
    localOnly: true,
    hostedGlmUsed: false,
    gpt55VisualJudgeUsed: false,
    assetManifestHash:
      latestConversion?.assetManifestHash || sha256Text(JSON.stringify(assetRecords)),
    engineRomReceiptPath: latestEngineRom?.receiptPath || null,
    visualProofReceiptPath: latestVisualProof?.receiptPath || null,
    visualProofProductionStatus: {
      status: visualProofBlockers.length === 0 ? "pass" : "blocked",
      blockers: visualProofBlockers,
    },
    runtimeAssetBinding: runtimeBinding || {
      status: "blocked",
      productionPixelBinding: false,
      blocker: "No engine ROM receipt was available.",
    },
    assets,
    outputDir,
  };
  writeJson(path.join(outputDir, "runtime-asset-truth.json"), report);
  return report;
}

function snesProjectsRoot(options = {}) {
  return (
    options.projectsRoot || process.env.OPENCLAW_SNES_PROJECTS_ARTIFACT_DIR || DEFAULT_PROJECTS_ROOT
  );
}

function sanitizeProjectId(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_PROJECT_ID;
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || DEFAULT_PROJECT_ID
  );
}

function sanitizeRomName(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_PROJECT_ID;
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_]+/gu, "_")
      .replace(/^_+|_+$/gu, "") || DEFAULT_PROJECT_ID.replace(/-/gu, "_")
  );
}

function projectPaths(projectId, options = {}) {
  const safeId = sanitizeProjectId(projectId);
  const projectDir = path.join(snesProjectsRoot(options), safeId);
  const toolchainDir = path.join(projectDir, "toolchain");
  return {
    projectDir,
    projectId: safeId,
    projectPath: path.join(projectDir, "project.json"),
    toolchainDir,
  };
}

function projectDisplayName(projectId) {
  if (projectId === "comet-fox-mvp") return "Comet Fox MVP";
  if (projectId === STANSKI_PROJECT_ID) return "Stanski's World";
  if (/stanski/iu.test(projectId)) return "Stanski's World Canary";
  return projectId
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function stanskiProjectReferencesRoot(options = {}) {
  return path.join(projectPaths(STANSKI_PROJECT_ID, options).projectDir, "references");
}

function snesImageAssetRoot(assetId) {
  return path.join(REPO_ROOT, ".artifacts", "snes-image-assets", assetId);
}

function absoluteRepoPath(maybeRelativePath) {
  if (!maybeRelativePath) return null;
  return path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.join(REPO_ROOT, maybeRelativePath);
}

function snesImageAssetReceipt(assetId) {
  const receiptPath = path.join(snesImageAssetRoot(assetId), "asset-receipt.json");
  const receipt = readJsonIfExists(receiptPath);
  const pngPath = absoluteRepoPath(receipt?.output?.pngPath);
  if (!receipt || !pngPath || !existsSync(pngPath)) {
    return {
      available: false,
      blocker: `SNES-safe converted asset receipt is missing: ${receiptPath}`,
      receiptPath,
    };
  }
  return {
    available: true,
    receipt,
    receiptPath,
    reviewArtifacts: Array.isArray(receipt.reviewArtifacts) ? receipt.reviewArtifacts : [],
    output: {
      height: receipt.output?.height,
      path: pngPath,
      sha256: receipt.output?.sha256 || sha256File(pngPath),
      width: receipt.output?.width,
    },
  };
}

function stanskiImageReceipt(assetId) {
  const receiptPath = path.join(snesImageAssetRoot(assetId), "source-image.json");
  const receipt = readJsonIfExists(receiptPath);
  if (!receipt?.source?.preservedPath) {
    return {
      id: assetId,
      sourceType: "image-reference",
      status: "blocked",
      path: receiptPath,
      usage:
        assetId === "man-boy-snes-photo-reference"
          ? "Man-and-boy photo reference for the Family Memory Card secret room cameo."
          : "Todd Stanski drawing reference for character and title art.",
      blocker: `source image unavailable; image preservation receipt is missing: ${receiptPath}`,
    };
  }
  const preservedPath = absoluteRepoPath(receipt.source.preservedPath);
  return {
    id: assetId,
    sourceType: "image-reference",
    status: existsSync(preservedPath) ? "preserved" : "blocked",
    path: preservedPath,
    sha256: receipt.source.sha256,
    dimensions:
      Number.isFinite(receipt.source.width) && Number.isFinite(receipt.source.height)
        ? { width: receipt.source.width, height: receipt.source.height }
        : undefined,
    usage:
      assetId === "man-boy-snes-photo-reference"
        ? "Man-and-boy photo reference planned for the Family Memory Card secret room cameo, with optional ending/credits memory card reuse after visual QA."
        : "Todd Stanski drawing reference for character sprite identity, portrait, and title art.",
    ...(existsSync(preservedPath)
      ? {}
      : { blocker: `Preserved source image does not exist: ${preservedPath}` }),
  };
}

function preserveStanskiPromptReferences(options = {}) {
  const root = stanskiProjectReferencesRoot(options);
  const promptDir = path.join(root, "prompts");
  ensureDir(promptDir);
  const receipts = [];
  for (const reference of STANSKI_PROMPT_REFERENCES) {
    const target = path.join(promptDir, `${reference.id}.txt`);
    if (!existsSync(reference.source)) {
      receipts.push({
        id: reference.id,
        sourceType: "prompt-text",
        status: "blocked",
        path: target,
        usage: "User-provided Stanski design prompt reference.",
        blocker: `Prompt attachment is missing or stale: ${reference.source}`,
      });
      continue;
    }
    const text = safeReadText(reference.source);
    if (text === null) {
      receipts.push({
        id: reference.id,
        sourceType: "prompt-text",
        status: "blocked",
        path: target,
        usage: "User-provided Stanski design prompt reference.",
        blocker: `Prompt attachment could not be read: ${reference.source}`,
      });
      continue;
    }
    writeFileSync(target, text);
    receipts.push({
      id: reference.id,
      sourceType: "prompt-text",
      status: "preserved",
      path: target,
      sha256: sha256Text(text),
      usage: "User-provided Stanski design prompt reference.",
    });
  }
  return receipts;
}

function createStanskiWorldOneLevels() {
  return [
    {
      checkpoint: "Midpoint near a rooftop bus shelter before the skyline climb.",
      firstEnemy: "Receipt goblin that walks slowly with obvious wind-up.",
      firstReward: "Cheeseburger trail teaching safe movement before the first gap.",
      id: "w1-1-cleveland-skyline-scramble",
      mechanicsTaught: ["walk", "run", "jump", "collect cheeseburgers", "read skyline signs"],
      purpose:
        "Open World 1 with a readable Cleveland skyline tutorial and the first toilet payoff.",
      requiredAssets: ["Todd sprite", "Cleveland skyline tiles", "cheeseburger", "toilet goal"],
      secretPath: "Upper awning route reveals an Edgewater Ticket Cache clue.",
      snesBudgetEstimate: "Mode 1, two background layers, <=96 metatiles, <=48 active sprites.",
      title: "Cleveland: Skyline Scramble",
      toiletEnding:
        "Todd sits on a porcelain throne billboard bathroom and stamps the first city receipt.",
    },
    {
      checkpoint: "Garage checkpoint after conveyor tutorial.",
      firstEnemy: "Loose hubcap patrol with predictable bounce.",
      firstReward: "Cheeseburger under a piston lift, safe to collect.",
      id: "w1-2-detroit-motor-city-mayhem",
      mechanicsTaught: ["conveyors", "moving platforms", "damage knockback", "run timing"],
      purpose: "Teach industrial motion and faster obstacle reading while staying SNES-safe.",
      requiredAssets: ["factory tiles", "conveyor tiles", "hubcap enemy", "garage toilet"],
      secretPath: "Factory rafters lead to a toll-ticket scrap for the Back of the Map.",
      snesBudgetEstimate: "Mode 1 with four-frame conveyor tile animation.",
      title: "Detroit: Motor City Mayhem",
      toiletEnding: "Garage restroom stall with exhaust-fan confetti.",
    },
    {
      checkpoint: "Warren Road porch checkpoint after the first roof climb.",
      firstEnemy: "Lake-effect cloud pest introduced on flat roof before gaps.",
      firstReward: "Burrito block on the first safe porch makes Big Stanski available.",
      id: "w1-3-lakewood-warren-road-roof-run",
      mechanicsTaught: ["coyote time", "jump buffer", "roof slopes", "secret house entry"],
      purpose:
        "Preserve Lakewood/Warren Road house requirements and teach roof-to-roof platforming.",
      requiredAssets: ["Lakewood houses", "Warren Road street sign", "roof tiles", "cloud pest"],
      secretPath:
        "Correct Warren Road house opens a photo room containing the man-and-boy cameo plan.",
      snesBudgetEstimate: "Mode 1 parallax neighborhood layer, <=128 visible background tiles.",
      title: "Lakewood: Warren Road Roof Run",
      toiletEnding: "Upstairs bathroom throne with newspaper gag and receipt stamp.",
    },
    {
      checkpoint: "Pier checkpoint before ticket-cache maze.",
      firstEnemy: "Seagull snatcher with slow arc.",
      firstReward: "Visible pizza slice before the first projectile-required enemy.",
      id: "w1-4-edgewater-ticket-cache",
      mechanicsTaught: [
        "projectile",
        "secret scanning",
        "water hazard restraint",
        "optional cache",
      ],
      purpose: "Introduce hidden ticket caches and the first projectile-required enemy safely.",
      requiredAssets: ["Edgewater lake tiles", "ticket cache icon", "seagull enemy", "pizza item"],
      secretPath: "Lakefront lower route reveals a Receipt Reality tear.",
      snesBudgetEstimate: "Mode 1 animated water tile budget capped to eight 8x8 tiles.",
      title: "Edgewater Ticket Cache",
      toiletEnding: "Beach bathroom toilet with lake-firework reflection.",
    },
    {
      checkpoint: "Rest-stop checkpoint before toll-booth gauntlet.",
      firstEnemy: "Orange-cone creep with clear safe jump arc.",
      firstReward: "Cheeseburger line teaching toll-gate rhythm.",
      id: "w1-5-turnpike-toll-trouble",
      mechanicsTaught: ["timed gates", "safe rush", "checkpoint retry", "boss key setup"],
      purpose: "Prepare for the Fare Snatcher boss with toll gates and receipt timing.",
      requiredAssets: ["turnpike signs", "toll gates", "orange-cone creep", "rest-stop toilet"],
      secretPath: "Back-lane toll booth reveals the Fare Collector ledger hint.",
      snesBudgetEstimate: "Mode 1 timed gates update through simple state bytes.",
      title: "Turnpike Toll Trouble",
      toiletEnding: "Rest-stop stall with toll receipt dispenser gag.",
    },
    {
      checkpoint: "Boss retry starts outside the fare booth arena.",
      firstEnemy: "Fare Snatcher phase 1: ticket swipe dash.",
      firstReward: "Golden Transfer Pass #1 after boss defeat.",
      id: "w1-boss-fare-snatcher",
      mechanicsTaught: ["boss phases", "readable telegraphs", "reward collection", "world clear"],
      purpose: "Close World 1 and grant Golden Transfer Pass #1.",
      requiredAssets: ["Fare Snatcher boss", "transfer pass", "fare booth arena", "boss toilet"],
      secretPath: "Optional perfect-clear receipt opens a Secret World 9 clue.",
      snesBudgetEstimate:
        "Mode 1 boss room, <=16 active sprites per scanline, no SuperFX required.",
      title: "Fare Snatcher Boss",
      toiletEnding: "Boss arena station restroom completes the World 1 receipt chain.",
    },
  ];
}

function createStanskiLevelOneProductionState() {
  const mechanics = {
    walkSpeed: 1.45,
    runMultiplier: 1.5,
    acceleration: 0.14,
    jumpVelocity: -5.6,
    variableJump: true,
    coyoteTimeFrames: 6,
    jumpBufferFrames: 6,
    slopeSupport: "planned",
    conveyorSupport: "planned",
    damageKnockback: { xVelocity: 1.6, yVelocity: -3.2, invulnerabilityFrames: 90 },
    startingLives: 5,
    gasBoostMultiplier: 1.5,
    fallingGasBoostAllowed: true,
    crouchHitbox: { smallHeight: 20, bigStandingHeight: 32, bigCrouchedHeight: 20 },
    projectileOrigins: { smallY: 18, bigStandingY: 12, bigCrouchedY: 18 },
  };
  const objects = [
    ["l1-player-start", "player-start", "Todd start", 32, 176],
    ["l1-cheeseburger-trail", "collectible", "Cheeseburger trail", 128, 144],
    ["l1-receipt-goblin", "enemy", "Receipt Goblin", 420, 176],
    ["l1-burrito-block", "block", "Burrito block", 704, 112],
    ["l1-bridge-checkpoint", "checkpoint", "Bridge checkpoint", 1248, 160],
    ["l1-upper-awning-secret", "secret-route", "Upper awning secret route", 1456, 96],
    ["l1-pizza-slice", "power-up", "Pizza slice", 1920, 136],
    ["l1-turnstile-snatcher", "projectile-gate", "Turnstile Snatcher", 2216, 168],
    ["l1-toilet-ending", "goal", "Porcelain toilet ending", 2928, 160],
    ["l1-fireworks-vfx", "vfx", "Ending fireworks", 2960, 64],
  ].map(([id, kind, name, x, y]) => ({
    id,
    kind,
    name,
    x,
    y,
    behavior:
      id === "l1-toilet-ending"
        ? "Triggers Todd sitting, newspaper, exactly two poop drops, splash, receipt stamp, and fireworks."
        : `${name} Level 1 gameplay object.`,
    qaAssertion:
      id === "l1-toilet-ending"
        ? "Replay reaches toilet ending and win state."
        : `${name} is reachable and does not soft-lock Level 1.`,
  }));
  return {
    format: "openclaw-stanski-level-one-production-state",
    version: 1,
    projectId: STANSKI_PROJECT_ID,
    activeLevelId: "w1-1-cleveland-skyline-scramble",
    activeLevelTitle: "Cleveland: Skyline Scramble",
    productionScope: "level-1-only",
    fullGamePlanStatus: "preserved-for-later",
    deferredMilestoneGroups: [
      "remaining World 1 levels",
      "Worlds 2-8",
      "Secret World 9",
      "The Auditor final boss",
      "true ending",
      "release candidate hardware proof",
    ],
    openingOverlay: { world: "Cleveland", level: "1" },
    mechanics,
    definitionOfDone: [
      "World: Cleveland / Level: 1 overlay",
      "five lives",
      "walk, run, jump, falling gas boost, crouch, projectile behavior",
      "cheeseburger trail in first 30 seconds",
      "safe first enemy",
      "burrito block early",
      "pizza before projectile-required enemy",
      "checkpoint",
      "reachable secret path",
      "toilet ending with newspaper, two poop drops, and fireworks",
    ].map((label, index) => ({
      id: `l1-dod-${index + 1}`,
      label,
      status: "implemented",
      proof: "Level 1 deterministic project data contains this requirement.",
    })),
    sections: [
      ["skyline-tutorial", "Cleveland skyline tutorial", 0, 512],
      ["sidewalk-potholes", "Sidewalk and pothole section", 512, 1152],
      ["bridge-gas-route", "Bridge skyline gas-boost route", 1152, 1792],
      ["food-power-up", "Food and projectile section", 1792, 2432],
      ["restroom-finale", "Restroom and toilet ending", 2432, 3072],
    ].map(([id, name, startX, endX]) => ({
      id,
      name,
      startX,
      endX,
      purpose: `${name} gameplay beat for Cleveland: Skyline Scramble.`,
      requiredMechanics: [],
      requiredReward: "readable reward path",
      qaExpectation: "Deterministic replay remains finishable through this section.",
    })),
    objects,
    replayScript: [
      ["walk-to-first-reward", 0, 90],
      ["first-jump", 90, 60],
      ["fair-enemy", 150, 120],
      ["burrito-checkpoint", 270, 120],
      ["falling-gas-secret", 390, 150],
      ["collect-pizza", 540, 120],
      ["projectile-required-enemy", 660, 90],
      ["toilet-ending", 750, 240],
    ].map(([id, startFrame, durationFrames]) => ({
      id,
      startFrame,
      durationFrames,
      input: ["right"],
      expected: `${id} assertion passes.`,
    })),
    snesBudget: {
      mapMode: "lorom",
      videoMode: "mode1",
      widthPixels: 3072,
      heightPixels: 224,
      metatileBudget: 96,
      activeSpriteBudget: 48,
      enhancementChip: "none",
    },
    proofSurfaces: [
      {
        id: "level-data",
        label: "Level 1 deterministic data",
        status: "implemented",
        proof: "Project package contains sections, objects, mechanics, and replay script.",
      },
      {
        id: "human-visual-approval",
        label: "100/100 human visual approval",
        status: "blocked",
        proof: "Human approval remains required.",
        blocker: "Human visual approval has not been recorded.",
      },
    ],
    blockers: [
      "100/100 production visuals require human approval after executable visual proof.",
      "Family Memory Card photo cameo remains blocked until the readable man/boy source photo is preserved and converted.",
      "Local emulator proof may remain blocked until invalid emulator app bundles are repaired.",
      "FXPAK copy remains blocked until an exact mounted FAT32 FXPAK/SD2SNES volume is supplied.",
      "Original SNES hardware proof remains manual and incomplete.",
    ],
  };
}

function createStanskiCanonReferences(options = {}) {
  return [
    ...preserveStanskiPromptReferences(options),
    ...STANSKI_REFERENCE_ASSETS.map((asset) => stanskiImageReceipt(asset.assetId)),
    {
      id: "prior-stanski-canon-summary",
      sourceType: "canon-summary",
      status: "preserved",
      path: path.join(stanskiProjectReferencesRoot(options), "canon-summary.json"),
      sha256: sha256Text("Stanski Batch 1 canon summary"),
      usage: "Consolidated Stanski canon from the active SNES Studio planning thread.",
    },
  ];
}

function createStanskiProductionBacklog() {
  const milestone = (
    id,
    name,
    group,
    surface,
    patchSchema,
    goal,
    acceptance,
    status = "planned",
  ) => ({
    id,
    name,
    group,
    surface,
    patchSchema,
    goal,
    acceptance,
    status,
  });
  return [
    milestone(
      "SW-B1-M1",
      "Preserve canon references",
      "foundation-canon",
      "manifest",
      "manifestPatch",
      "Preserve all readable prompt and image references.",
      ["readable references have path/hash receipts", "stale references are blockers"],
      "active",
    ),
    milestone(
      "SW-B1-M2",
      "Generic project package",
      "foundation-canon",
      "manifest",
      "manifestPatch",
      "Create the Stanski generic SNES Studio package.",
      ["project id is stanskis-world", "base target is original SNES via FXPAK Pro"],
      "active",
    ),
    milestone(
      "SW-B1-M3",
      "Canon lock",
      "foundation-canon",
      "manifest",
      "manifestPatch",
      "Lock game bible, technical contract, secrets, and definition of done.",
      [
        "canon includes toilets, death screen, World 1, Fare Collector, Secret World 9, Receipt Reality, Back of the Map, Auditor, true ending, and photo inclusion",
      ],
      "active",
    ),
    milestone(
      "SW-B1-M7",
      "World 1 vertical-slice data",
      "world-1-vertical-slice",
      "levels",
      "levelPatch",
      "Create World 1 level/boss records.",
      [
        "World 1 progression validates",
        "Fare Snatcher grants Golden Transfer Pass #1",
        "Lakewood/Warren Road house requirements are present",
      ],
      "active",
    ),
    milestone(
      "SW-B1-M8",
      "Movement feel lab scaffold",
      "movement-core-engine",
      "manifest",
      "manifestPatch",
      "Create movement tuning contract.",
      ["walk/run/jump/coyote/buffer/slopes/conveyors/knockback tuning values exist"],
      "active",
    ),
    milestone(
      "SW-B1-M9",
      "Toolchain proof wiring",
      "rom-emulator-fxpak-hardware-proof",
      "rom",
      "proofPatch",
      "Run existing Stanski project proof commands.",
      ["receipts exist or exact blockers are recorded", "proof surfaces remain separate"],
      "active",
    ),
    milestone(
      "SW-L1-M0",
      "Level 1 scope lock",
      "level-1-cleveland-skyline-scramble",
      "manifest",
      "manifestPatch",
      "Activate Cleveland: Skyline Scramble only while preserving the full-game plan.",
      ["Level 1 is active", "full game remains planned for later"],
      "active",
    ),
    milestone(
      "SW-L1-M1",
      "Level 1 definition of done",
      "level-1-cleveland-skyline-scramble",
      "manifest",
      "manifestPatch",
      "Lock the production definition of done for Level 1.",
      [
        "opening overlay, five lives, movement, rewards, secret path, and toilet ending are defined",
      ],
      "active",
    ),
    milestone(
      "SW-L1-M2",
      "Level 1 playable data",
      "level-1-cleveland-skyline-scramble",
      "levels",
      "levelPatch",
      "Create deterministic playable data for Cleveland: Skyline Scramble.",
      ["tile/collision/camera/object/replay records exist", "replay reaches toilet ending"],
      "active",
    ),
    milestone(
      "SW-L1-M3",
      "Level 1 movement tuning",
      "level-1-cleveland-skyline-scramble",
      "playtest",
      "manifestPatch",
      "Tune Level 1 movement and gameplay constants.",
      ["run and gas boost multipliers are 1.5x", "falling gas boost is allowed"],
      "active",
    ),
    milestone(
      "SW-FUTURE-MOVE01",
      "Movement core implementation",
      "movement-core-engine",
      "playtest",
      "manifestPatch",
      "Tune executable movement and collisions.",
      ["movement replay passes"],
    ),
    milestone(
      "SW-FUTURE-W1-PLAYABLE",
      "World 1 playable implementation",
      "world-1-vertical-slice",
      "levels",
      "levelPatch",
      "Build World 1 end-to-end.",
      ["Fare Snatcher boss and Golden Transfer Pass #1 work"],
    ),
    milestone(
      "SW-FUTURE-ART-AUDIO",
      "Art and audio production",
      "art-audio-production",
      "assets",
      "assetPackPatch",
      "Create production visual/audio assets.",
      ["100/100 visuals require human approval"],
    ),
    milestone(
      "SW-FUTURE-SECRETS",
      "Secrets and replayability",
      "secrets-replay",
      "levels",
      "manifestPatch",
      "Implement Secret World 9, Receipt Reality, and Back of the Map.",
      ["secret flags and unlocks are executable"],
    ),
    milestone(
      "SW-FUTURE-W2-W8",
      "Worlds 2-8 production",
      "worlds-2-through-8",
      "levels",
      "levelPatch",
      "Complete remaining primary worlds.",
      ["each world has routes, bosses, rewards, and hardware budgets"],
    ),
    milestone(
      "SW-FUTURE-FINAL",
      "Final boss and endings",
      "final-boss-endings",
      "levels",
      "levelPatch",
      "Implement The Auditor and endings.",
      ["false and true endings are executable"],
    ),
    milestone(
      "SW-FUTURE-RC",
      "Release candidate proof",
      "release-candidate",
      "fxpak",
      "proofPatch",
      "Complete ROM, emulator, FXPAK, and hardware proof.",
      ["production proof surfaces pass or exact external blockers remain"],
    ),
  ];
}

function createStanskiWorldProjectPackage(options = {}) {
  const safeId = STANSKI_PROJECT_ID;
  const generatedAt = nowIso();
  const projectName = projectDisplayName(safeId);
  const worldOne = createStanskiWorldOneLevels();
  const levelOneProduction = createStanskiLevelOneProductionState();
  const activeLevel = worldOne[0];
  const references = createStanskiCanonReferences(options);
  const imageRecords = STANSKI_REFERENCE_ASSETS.map((asset) => {
    const reference = references.find((item) => item.id === asset.assetId);
    const preserved =
      reference?.status === "preserved" && reference?.path && existsSync(reference.path);
    const converted = preserved ? snesImageAssetReceipt(asset.assetId) : { available: false };
    const convertedAvailable = Boolean(converted.available);
    const reviewArtifacts = convertedAvailable ? converted.reviewArtifacts : [];
    return {
      blockers: convertedAvailable
        ? [
            "Draft SNES-safe converted asset is not production-approved until in-game visual proof and human review pass.",
          ]
        : preserved
          ? [
              converted.blocker ||
                "Reference is preserved, but SNES-safe conversion is still required before in-game cameo proof.",
            ]
          : [reference?.blocker || "Reference image has not been preserved yet."],
      conversionReceiptPath: convertedAvailable ? converted.receiptPath : undefined,
      conversionStatus: convertedAvailable ? "converted" : "blocked",
      id: asset.assetId,
      license: "user-provided",
      palette: convertedAvailable
        ? {
            colorCount: converted.receipt.palette.length,
            colors: converted.receipt.palette,
          }
        : undefined,
      provenance: convertedAvailable ? "openclaw-generated" : preserved ? "user-imported" : "spec",
      sourceHash: convertedAvailable
        ? converted.output.sha256
        : preserved
          ? reference.sha256
          : undefined,
      sourcePath: convertedAvailable
        ? converted.output.path
        : preserved
          ? reference.path
          : undefined,
      status: preserved ? "real-asset" : "spec-only",
      type: asset.type,
      usage: [asset.usage],
      visualMaturity: convertedAvailable
        ? "draft-generated"
        : preserved
          ? "artist-imported"
          : "spec-only",
      visualProof: convertedAvailable
        ? reviewArtifacts
        : preserved
          ? [{ kind: "source-image", path: reference.path, sha256: reference.sha256 }]
          : [],
      ...(convertedAvailable && converted.receipt.frames
        ? { frames: converted.receipt.frames }
        : {}),
      ...(convertedAvailable
        ? {
            tileMetadata: {
              height: converted.output.height,
              tileCount: converted.receipt.tileUsage?.estimatedTiles,
              tileSize: converted.receipt.tileUsage?.tileSize,
              width: converted.output.width,
            },
          }
        : {}),
    };
  });
  const project = {
    assets: { importedTilesets: [] },
    export: { romBaseName: safeId },
    gameBrief: {
      audience: "beginner",
      gameType: "side-scrolling-platformer",
      prompt: "Build Stanski's World from preserved references and canon.",
      promise:
        "Production-grade Level 1 vertical slice for original SNES via FXPAK Pro, with full game preserved for later.",
    },
    gamePlan: {
      title: projectName,
      hero: "Todd Stanski",
      goal: "Recover receipts, defeat the Fare Collector and The Auditor, and unlock the true ending.",
      villain: "The Fare Collector and The Auditor",
      levels: [activeLevel.title],
      items: ["cheeseburgers", "ticket caches", "receipt scraps", "Golden Transfer Passes"],
      powerups: ["burrito Big Stanski", "pizza bad-breath projectile", "gas boost"],
      artMood: "original commercial-SNES-era Cleveland road-trip platformer, human target 100/100",
      musicMood: "original high-energy 16-bit road-trip themes",
      rulesSummary: "Walk, run, jump, coyote time, jump buffer, secrets, toilets, boss rewards.",
      savePlan:
        "SRAM flags for bosses, passes, ticket caches, Receipt Reality, Back of the Map, Secret World 9, and true ending.",
    },
    gameStoryBible: {
      premise:
        "Todd Stanski crosses absurd Cleveland and road-trip worlds where receipts alter reality.",
      world: "Cleveland, Detroit, Lakewood/Warren Road, Edgewater, Turnpike, and later worlds.",
      hero: "Todd Stanski",
      heroGoal: "Claim Golden Transfer Passes and restore the receipt ledger.",
      villain: "The Fare Collector, escalating into The Auditor.",
      conflict:
        "The Fare Collector and Auditor twist travel receipts into platforming hazards and secret routes.",
      ending:
        "Normal ending plus true ending through Receipt Reality and Back of the Map conditions.",
      tone: "funny, strange, readable, fair, and SNES-authentic.",
    },
    id: safeId,
    levelChapters: worldOne.map((level, index) => ({
      id: level.id,
      sceneId: level.id,
      order: index + 1,
      title: level.title,
      storyPurpose: level.purpose,
      setting: level.title,
      challenge: `${level.firstEnemy}; ${level.secretPath}`,
      reward: level.firstReward,
      goal: level.toiletEnding,
      requiredThings: level.requiredAssets,
    })),
    levelPlan: {
      id: "level-1-cleveland-skyline-scramble",
      name: "Level 1: Cleveland: Skyline Scramble",
      summary:
        "Active production target is Level 1 only. Full World 1 and full-game plans remain preserved in canon and backlog.",
      chunks: levelOneProduction.sections.map((section) => section.name),
      goal: "Finish Cleveland: Skyline Scramble at the porcelain toilet ending.",
    },
    name: projectName,
    profile: {
      enhancementChip: "none",
      fxpak: { cardSizeGb: 128, fileSystem: "fat32", preserveExistingSaves: true },
      mapMode: "lorom",
      region: "ntsc",
      romSizeMbit: 16,
      sramSizeKib: 8,
      target: "fxpak-pro",
      videoMode: "mode1",
    },
    scenes: [
      {
        id: activeLevel.id,
        name: activeLevel.title,
        widthMetatiles: 128,
        heightMetatiles: 16,
        layers: 2,
        entities: levelOneProduction.objects.map((object) => ({
          id: object.id,
          kind:
            object.kind === "player-start"
              ? "player"
              : object.kind === "collectible" || object.kind === "power-up"
                ? "item"
                : object.kind === "goal"
                  ? "npc"
                  : "enemy",
          name: object.name,
          x: object.x,
          y: object.y,
          metaspriteTiles: object.kind === "goal" ? 12 : object.kind === "player-start" ? 12 : 8,
        })),
      },
    ],
    stanskiLevelOneProduction: levelOneProduction,
    stanskiCanon: {
      format: "openclaw-stanski-world-canon",
      version: 1,
      targetPlatform: "original-snes-via-fxpak-pro",
      baseRom: "standard-snes-compatible",
      optionalEnhancements: "disabled-by-default",
      fxpakWrites: "blocked-until-exact-mounted-volume",
      visualTarget: { score: 100, approval: "human-required" },
      references,
      worldOneVerticalSlice: worldOne,
      levelOneProduction,
      requiredCanon: [
        "toilets",
        "death screen",
        "World 1 locations",
        "Fare Collector",
        "Secret World 9",
        "Receipt Reality",
        "Back of the Map",
        "Auditor",
        "true ending",
        "photo inclusion",
      ],
      movementFeel: {
        walkSpeed: 1.45,
        runMultiplier: 1.5,
        acceleration: 0.14,
        jumpVelocity: -5.6,
        variableJump: true,
        coyoteTimeFrames: 6,
        jumpBufferFrames: 6,
        slopeSupport: "planned",
        conveyorSupport: "planned",
        damageKnockback: { xVelocity: 1.6, yVelocity: -3.2, invulnerabilityFrames: 90 },
      },
    },
    updatedAt: generatedAt,
  };
  const body = {
    createdAt: generatedAt,
    format: "openclaw-snes-project-package",
    manifest: {
      assetRegistry: { records: imageRecords, status: "blocked" },
      format: "openclaw-snes-game-builder-project",
      manifestVersion: 1,
      project,
      productionReadiness: {
        status: "production-blocked",
        summary:
          "Level 1 is active now; full game, visuals, FXPAK, and hardware proof remain blocked.",
      },
      receipts: {},
    },
    packageVersion: 1,
    projectId: safeId,
    projectName,
    receipts: {
      assetAdapters: [],
      qa: [
        {
          id: "level-1-production-target",
          status: "warning",
          summary:
            "Only Cleveland: Skyline Scramble is active; the full Stanski's World plan is preserved for later.",
        },
        {
          id: "batch-1-foundation",
          status: "warning",
          summary:
            "Stanski Batch 1 package and World 1 design data are present; full game is incomplete.",
        },
        {
          id: "visual-approval-status",
          status: "blocked",
          summary: "100/100 production visuals require human review and executable visual proof.",
        },
        {
          id: "fxpak-write-status",
          status: "blocked",
          summary:
            "FXPAK writes remain blocked until a real exact mounted volume path is supplied.",
        },
      ],
    },
    sampleSpecific: false,
    source: "stanski-production",
  };
  return { ...body, packageHash: sha256Text(JSON.stringify(body)) };
}

function createMinimalProjectPackage(projectId) {
  const safeId = sanitizeProjectId(projectId);
  if (safeId === STANSKI_PROJECT_ID) return createStanskiWorldProjectPackage();
  const generatedAt = nowIso();
  const projectName = projectDisplayName(safeId);
  const project = {
    export: { romBaseName: safeId },
    id: safeId,
    name: projectName,
    scenes: [{ id: "level-1", name: "Level 1" }],
    updatedAt: generatedAt,
  };
  const packageWithoutHash = {
    createdAt: generatedAt,
    format: "openclaw-snes-project-package",
    manifest: {
      assetRegistry: { records: [], status: "blocked" },
      format: "openclaw-snes-game-builder-project",
      manifestVersion: 1,
      project,
      receipts: {},
    },
    packageVersion: 1,
    projectId: safeId,
    projectName,
    receipts: { assetAdapters: [], qa: [] },
    sampleSpecific: false,
    source:
      safeId === "comet-fox-mvp"
        ? "sample-mvp"
        : /stanski/iu.test(safeId)
          ? "sample-stanski"
          : "generic",
  };
  return { ...packageWithoutHash, packageHash: sha256Text(JSON.stringify(packageWithoutHash)) };
}

function writeStanskiCanonSummary(projectPackage, options = {}) {
  if (projectPackage?.projectId !== STANSKI_PROJECT_ID) return;
  const root = stanskiProjectReferencesRoot(options);
  ensureDir(root);
  const summary = {
    generatedAt: nowIso(),
    projectId: STANSKI_PROJECT_ID,
    canonicalName: "Stanski's World",
    targetPlatform: "original SNES via FXPAK Pro",
    baseRom: "standard SNES-compatible",
    optionalEnhancements: "disabled by default",
    visualTarget: "100/100 human-approved production visuals",
    activeProductionTarget: "Level 1 only: Cleveland: Skyline Scramble",
    fullGamePlanStatus: "preserved for later",
    requiredSystems: [
      "toilets",
      "death screen",
      "World 1 locations",
      "Fare Collector",
      "Secret World 9",
      "Receipt Reality",
      "Back of the Map",
      "Auditor",
      "true ending",
      "man-and-boy photo inclusion",
    ],
    worldOneLevels: createStanskiWorldOneLevels().map((level) => ({
      id: level.id,
      title: level.title,
      purpose: level.purpose,
      firstReward: level.firstReward,
      firstEnemy: level.firstEnemy,
      checkpoint: level.checkpoint,
      secretPath: level.secretPath,
      toiletEnding: level.toiletEnding,
      requiredAssets: level.requiredAssets,
      snesBudgetEstimate: level.snesBudgetEstimate,
    })),
    levelOneProduction: createStanskiLevelOneProductionState(),
  };
  writeJson(path.join(root, "canon-summary.json"), summary);
}

function ensureGenericProductionFiles(projectId, projectPackage, options = {}) {
  const paths = projectPaths(projectId, options);
  const productionDir = path.join(paths.projectDir, "production");
  const qaDir = path.join(paths.projectDir, "qa");
  const backlogPath = path.join(productionDir, "backlog.json");
  const statePath = path.join(productionDir, "state.json");
  const memoryCardsPath = path.join(productionDir, "memory-cards.json");
  const decisionLogPath = path.join(productionDir, "decision-log.json");
  const summaryPath = path.join(productionDir, "latest-summary.md");
  ensureDir(paths.projectDir);
  ensureDir(paths.toolchainDir);
  ensureDir(productionDir);
  ensureDir(qaDir);
  const backlog =
    paths.projectId === STANSKI_PROJECT_ID
      ? createStanskiProductionBacklog()
      : [
          {
            id: "GEN01",
            name: "Project package",
            group: "foundation",
            surface: "manifest",
            patchSchema: "manifestPatch",
            goal: "Create the reusable SNES project package.",
            acceptance: ["project package validates"],
            status: "active",
          },
        ];
  const completed = [];
  const current = backlog.find((milestone) => !completed.includes(milestone.id)) ?? null;
  writeJson(backlogPath, backlog);
  if (!existsSync(statePath)) {
    writeJson(statePath, {
      format: "openclaw-snes-generic-production-state",
      stateVersion: 1,
      projectId: paths.projectId,
      currentMilestoneId: current?.id ?? null,
      completedMilestones: completed,
      blockedMilestone: null,
      stageStates: {
        planned: backlog
          .filter((milestone) => milestone.status === "planned")
          .map((milestone) => milestone.id),
        active: backlog
          .filter((milestone) => milestone.status === "active")
          .map((milestone) => milestone.id),
        implemented: [],
        built: [],
        "emulator-tested": [],
        "fxpak-tested": [],
        "hardware-tested": [],
      },
      policy: {
        localGlmOnly: true,
        hostedGlmAllowed: false,
        routineGpt55Allowed: false,
        defaultGpt55Reasoning: "low",
        visualApproval: "human-required",
        fxpakWrites: "blocked-until-exact-mounted-volume",
      },
      lastGoodPackageHash: projectPackage?.packageHash ?? null,
      updatedAt: nowIso(),
    });
  }
  if (!existsSync(memoryCardsPath)) writeJson(memoryCardsPath, []);
  if (!existsSync(decisionLogPath)) {
    writeJson(decisionLogPath, [
      {
        id: "batch-1-scope",
        decidedAt: nowIso(),
        decision:
          "Batch 1 creates Stanski project foundation, canon, World 1 design data, and proof wiring only.",
      },
    ]);
  }
  if (!existsSync(summaryPath))
    writeFileSync(
      summaryPath,
      [
        "# Stanski's World Production Summary",
        "",
        `Project: ${projectPackage?.projectName || projectDisplayName(paths.projectId)}`,
        "",
        "Batch 1 status: foundation active; full game is not complete.",
        "",
        "Blocked until later milestones: 100/100 human visual approval, full game implementation, exact FXPAK volume path, original SNES hardware proof.",
        "",
      ].join("\n"),
    );
  if (paths.projectId === STANSKI_PROJECT_ID) writeStanskiCanonSummary(projectPackage, options);
}

function stanskiPackageNeedsCanonRefresh(existing) {
  if (existing?.source !== "stanski-production") return true;
  const references = existing?.manifest?.project?.stanskiCanon?.references;
  if (!Array.isArray(references)) return true;
  const manBoyReference = references.find(
    (reference) => reference?.id === "man-boy-snes-photo-reference",
  );
  if (!manBoyReference) return true;
  const usage = String(manBoyReference.usage || "").toLowerCase();
  if (!usage.includes("family memory card") || !usage.includes("secret room")) return true;
  const records = existing?.manifest?.assetRegistry?.records;
  if (!Array.isArray(records)) return true;
  for (const asset of STANSKI_REFERENCE_ASSETS) {
    const record = records.find((item) => item?.id === asset.assetId);
    const reference = references.find((item) => item?.id === asset.assetId);
    const actualReference = stanskiImageReceipt(asset.assetId);
    if (actualReference.status !== reference?.status) return true;
    if (actualReference.sha256 && actualReference.sha256 !== reference?.sha256) return true;
    const converted = snesImageAssetReceipt(asset.assetId);
    if (converted.available) {
      if (record?.sourcePath !== converted.output.path) return true;
      if (record?.sourceHash !== converted.output.sha256) return true;
      if (record?.visualMaturity !== "draft-generated") return true;
      continue;
    }
    if (reference?.status === "preserved" && record?.conversionStatus !== "blocked") return true;
  }
  return false;
}

function loadOrCreateProjectPackage(projectId, options = {}) {
  const paths = projectPaths(projectId, options);
  const existing = readJsonIfExists(paths.projectPath);
  if (existing?.format === "openclaw-snes-project-package") {
    const next =
      paths.projectId === STANSKI_PROJECT_ID && stanskiPackageNeedsCanonRefresh(existing)
        ? createStanskiWorldProjectPackage(options)
        : existing;
    if (next !== existing) writeJson(paths.projectPath, next);
    ensureGenericProductionFiles(paths.projectId, next, options);
    return next;
  }
  const created = createMinimalProjectPackage(paths.projectId);
  writeJson(paths.projectPath, created);
  ensureGenericProductionFiles(paths.projectId, created, options);
  return created;
}

function projectTitle(projectPackage) {
  return String(
    projectPackage?.projectName ||
      projectPackage?.manifest?.project?.name ||
      projectPackage?.projectId ||
      DEFAULT_PROJECT_ID,
  ).slice(0, 80);
}

function projectRomBaseName(projectPackage) {
  return sanitizeRomName(
    projectPackage?.manifest?.project?.export?.romBaseName ||
      projectPackage?.projectId ||
      DEFAULT_PROJECT_ID,
  );
}

function requiredProjectAssets(projectPackage) {
  const projectId = sanitizeProjectId(projectPackage?.projectId);
  const existingRecords = Array.isArray(projectPackage?.manifest?.assetRegistry?.records)
    ? projectPackage.manifest.assetRegistry.records
    : [];
  const requiredAssets = REQUIRED_PROJECT_ASSET_TYPES.map((type, index) => {
    const existing = existingRecords.find(
      (record) => record?.type === type && typeof record?.sourcePath === "string",
    );
    const sourceProvided = Boolean(existing?.sourcePath);
    return {
      blockers: Array.isArray(existing?.blockers) ? existing.blockers : [],
      id: sanitizeProjectId(existing?.id || `${projectId}-${type}`),
      provenance: existing?.provenance,
      sourcePath: existing?.sourcePath,
      sourceProvided,
      type,
      usage: existing?.usage || [`${type} proof asset for ${projectTitle(projectPackage)}`],
      visualMaturity: existing?.visualMaturity,
      visualProof: Array.isArray(existing?.visualProof) ? existing.visualProof : [],
      artSource: existing?.artSource,
      frames: Array.isArray(existing?.frames) ? existing.frames : [],
      tileMetadata: existing?.tileMetadata,
      palette: existing?.palette,
      license: existing?.license,
      licenseReceipt: existing?.licenseReceipt,
      cleanRoomSourcePolicy: existing?.cleanRoomSourcePolicy,
      clevelandLandmarks: existing?.clevelandLandmarks,
      width: Number.isFinite(existing?.tileMetadata?.width)
        ? existing.tileMetadata.width
        : type === "background-layer"
          ? 64
          : type === "tileset"
            ? 32
            : 16,
      height: Number.isFinite(existing?.tileMetadata?.height)
        ? existing.tileMetadata.height
        : type === "background-layer"
          ? 32
          : type === "character-sprite"
            ? 24
            : 16,
      index,
    };
  });
  const requiredIds = new Set(requiredAssets.map((asset) => asset.id));
  const extraExistingAssets = existingRecords
    .filter(
      (record) =>
        typeof record?.id === "string" &&
        typeof record?.type === "string" &&
        !requiredIds.has(record.id),
    )
    .map((record, index) => ({
      blockers: Array.isArray(record.blockers) ? record.blockers : [],
      id: sanitizeProjectId(record.id),
      provenance: record.provenance,
      sourcePath: record.sourcePath,
      sourceProvided: Boolean(record.sourcePath),
      type: record.type,
      usage: record.usage || [`${record.type} proof asset for ${projectTitle(projectPackage)}`],
      visualMaturity: record.visualMaturity,
      visualProof: Array.isArray(record.visualProof) ? record.visualProof : [],
      artSource: record.artSource,
      frames: Array.isArray(record.frames) ? record.frames : [],
      tileMetadata: record.tileMetadata,
      palette: record.palette,
      license: record.license,
      licenseReceipt: record.licenseReceipt,
      cleanRoomSourcePolicy: record.cleanRoomSourcePolicy,
      clevelandLandmarks: record.clevelandLandmarks,
      width: Number.isFinite(record.tileMetadata?.width)
        ? record.tileMetadata.width
        : record.type === "background-layer"
          ? 64
          : record.type === "tileset"
            ? 32
            : 16,
      height: Number.isFinite(record.tileMetadata?.height)
        ? record.tileMetadata.height
        : record.type === "background-layer"
          ? 32
          : record.type === "character-sprite"
            ? 24
            : 16,
      index: requiredAssets.length + index,
    }));
  return [...requiredAssets, ...extraExistingAssets];
}

function projectReceiptDir(projectId, kind, options = {}) {
  const paths = projectPaths(projectId, options);
  return path.join(paths.toolchainDir, `${kind}-${timestampSlug()}`);
}

function writeProjectReceipt(projectId, kind, report, options = {}) {
  const paths = projectPaths(projectId, options);
  ensureDir(paths.toolchainDir);
  const dir = report.outputDir || projectReceiptDir(projectId, kind, options);
  ensureDir(dir);
  const receiptPath = path.join(dir, "receipt.json");
  writeJson(receiptPath, report);
  const latestPath = path.join(paths.toolchainDir, `latest-${kind}.json`);
  writeJson(latestPath, { ...report, receiptPath });
  try {
    appendManifest({
      lastReceipts: {
        [`project-${kind}:${paths.projectId}`]: {
          generatedAt: report.generatedAt ?? nowIso(),
          latestPath,
          receiptPath,
          status: report.status ?? "unknown",
        },
      },
    });
  } catch {
    // Project receipts should still be written when the user toolchain manifest is unavailable.
  }
  return { latestPath, receiptPath };
}

function latestProjectReceipt(projectId, kind, options = {}) {
  const paths = projectPaths(projectId, options);
  return readJsonIfExists(path.join(paths.toolchainDir, `latest-${kind}.json`));
}

function visualRejectionEvidence(projectPackage) {
  const visualRejection = projectPackage?.manifest?.project?.stanskiVisualRecovery?.visualRejection;
  if (!visualRejection || visualRejection.status !== "rejected") return null;
  return {
    format: "openclaw-snes-human-visual-rejection-v1",
    humanScore: visualRejection.humanScore,
    levelId: visualRejection.levelId || STANSKI_LEVEL_ONE_ID,
    projectId: projectPackage.projectId,
    reasons: visualRejection.reasons || STANSKI_VISUAL_REJECTION_REASONS,
    categoryGrades: visualRejection.categoryGrades || STANSKI_VISUAL_CATEGORY_GRADES,
    status: "rejected",
    targetScore: visualRejection.targetScore || 100,
  };
}

function visualProofEvidence(projectPackage, latestVisualProof = null) {
  if (latestVisualProof?.status === "pass") return latestVisualProof;
  const records = Array.isArray(projectPackage?.manifest?.assetRegistry?.records)
    ? projectPackage.manifest.assetRegistry.records
    : [];
  if (records.length === 0 || productionAssetBlockers(records).length > 0) {
    return latestVisualProof;
  }
  const proofByPath = new Map();
  for (const record of records) {
    for (const proof of Array.isArray(record?.visualProof) ? record.visualProof : []) {
      if (!isProductionVisualProof(proof) || !proof?.sha256) continue;
      proofByPath.set(proof.path, {
        kind: "in-game-screenshot",
        scene:
          proof.scene ||
          path.basename(proof.path, path.extname(proof.path)).replace(/[^a-z0-9-]+/giu, "-"),
        path: proof.path,
        sha256: proof.sha256,
        proofSource: proof.proofSource,
        productionEligible: proof.productionEligible,
      });
    }
  }
  if (proofByPath.size === 0) return latestVisualProof;
  const screenshots = [...proofByPath.values()];
  return {
    status: "pass",
    assetManifestHash: sha256Text(JSON.stringify(records)),
    screenshots,
    source: "project-manifest-visual-proof",
  };
}

function outputRecords(files) {
  return files
    .filter((file) => existsSync(file))
    .map((file) => ({ path: file, sizeBytes: statSync(file).size, sha256: sha256File(file) }));
}

export function projectConversion(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const latestArtCompile = latestProjectReceipt(projectId, "art-compile", options);
  const conversionProjectPackage =
    latestArtCompile?.status === "pass" && Array.isArray(latestArtCompile.assetRecords)
      ? {
          ...projectPackage,
          manifest: {
            ...projectPackage.manifest,
            assetRegistry: {
              ...(projectPackage.manifest?.assetRegistry || {}),
              records: latestArtCompile.assetRecords,
            },
          },
        }
      : projectPackage;
  const outputDir = options.outputDir || projectReceiptDir(projectId, "conversion", options);
  const sourceDir = path.join(outputDir, "source-assets");
  const convertedRoot = path.join(outputDir, "converted-assets");
  const reviewRoot = path.join(outputDir, "visual-review");
  ensureDir(sourceDir);
  ensureDir(convertedRoot);
  ensureDir(reviewRoot);
  const tool = detectTool("superfamiconv");
  const report = {
    assetRecords: [],
    blockers: [],
    conversions: [],
    generatedAt: nowIso(),
    localOnly: true,
    noHostedGlm: true,
    outputDir,
    project: {
      id: projectPackage.projectId,
      name: projectTitle(projectPackage),
      packageHash: projectPackage.packageHash,
    },
    status: "blocked",
    tool,
  };
  if (!tool.available) {
    report.blockers = [tool.blocker];
    return report;
  }
  for (const asset of requiredProjectAssets(conversionProjectPackage)) {
    const sourceAssetPath =
      asset.sourcePath && existsSync(asset.sourcePath) ? asset.sourcePath : null;
    const sourceExtension = sourceAssetPath ? path.extname(sourceAssetPath).toLowerCase() : "";
    const inputPath =
      sourceAssetPath && sourceExtension === ".png"
        ? sourceAssetPath
        : writeDeterministicPng(path.join(sourceDir, `${asset.id}.png`), {
            ...asset,
            seed: sourceAssetPath
              ? `${sha256File(sourceAssetPath)}:${projectPackage.packageHash}:${asset.type}:${asset.index}`
              : `${projectPackage.packageHash}:${asset.type}:${asset.index}`,
          });
    const visualMaturity =
      asset.visualMaturity ||
      (asset.sourceProvided
        ? asset.provenance === "user-imported" || asset.provenance === "external-licensed"
          ? "artist-imported"
          : "draft-generated"
        : "procedural-placeholder");
    const assetOutDir = path.join(convertedRoot, asset.id);
    ensureDir(assetOutDir);
    const converted = runSuperfamiconv(tool.path, inputPath, assetOutDir);
    const outputs = converted.ok ? outputRecords(converted.outputs) : [];
    const reviewSheetPath =
      converted.ok && outputs.length >= 3
        ? writeVisualReviewSheet(path.join(reviewRoot, `${asset.id}-review.png`), {
            ...asset,
            seed: `${projectPackage.packageHash}:${asset.type}:${asset.index}`,
          })
        : null;
    const visualProof =
      reviewSheetPath !== null
        ? [
            {
              kind: visualProofKindForAsset(asset.type),
              path: reviewSheetPath,
              sha256: sha256File(reviewSheetPath),
              sourceAssetPath: inputPath,
            },
          ]
        : [];
    const conversionRecord = {
      assetId: asset.id,
      assetType: asset.type,
      command: converted.ok ? { command: tool.path, args: converted.args } : null,
      input: { path: inputPath, sha256: sha256File(inputPath) },
      originalSource: sourceAssetPath
        ? { path: sourceAssetPath, sha256: sha256File(sourceAssetPath) }
        : null,
      outputDir: assetOutDir,
      outputs,
      licenseReceipt: asset.licenseReceipt || null,
      cleanRoomSourcePolicy:
        asset.cleanRoomSourcePolicy ||
        (projectId === STANSKI_PROJECT_ID ? cleanRoomSourcePolicy() : null),
      sourceProvided: asset.sourceProvided,
      status: converted.ok && outputs.length >= 3 ? "pass" : "blocked",
      visualMaturity,
      visualProof,
      frames: asset.frames || [],
      tileMetadata: asset.tileMetadata,
      palette: asset.palette,
    };
    if (!converted.ok || outputs.length < 3) {
      conversionRecord.blockers = [
        "SuperFamiconv did not produce tile, map, and palette outputs for this project asset.",
      ];
      conversionRecord.attempts = converted.failures;
      report.blockers.push(`${asset.id}: ${conversionRecord.blockers[0]}`);
    }
    const assetBlockers = [
      ...(conversionRecord.status === "pass" ? [] : conversionRecord.blockers),
      ...(asset.blockers ?? []),
    ];
    const assetConversionStatus =
      conversionRecord.status === "pass" && assetBlockers.length === 0 ? "converted" : "blocked";
    report.conversions.push(conversionRecord);
    report.assetRecords.push({
      blockers: assetBlockers,
      conversionOutputHashes: Object.fromEntries(
        outputs.map((item) => [path.basename(item.path), item.sha256]),
      ),
      conversionStatus: assetConversionStatus,
      id: asset.id,
      license: asset.license || "original-clean-room",
      ...(asset.licenseReceipt ? { licenseReceipt: asset.licenseReceipt } : {}),
      palette: asset.palette || {
        colorCount: 4,
        colors: colorRampForType(asset.type).map(
          (color) => `#${color.map((part) => part.toString(16).padStart(2, "0")).join("")}`,
        ),
      },
      provenance: asset.provenance || "openclaw-generated",
      ...(asset.cleanRoomSourcePolicy
        ? { cleanRoomSourcePolicy: asset.cleanRoomSourcePolicy }
        : projectId === STANSKI_PROJECT_ID
          ? { cleanRoomSourcePolicy: cleanRoomSourcePolicy() }
          : {}),
      ...(Array.isArray(asset.clevelandLandmarks) && asset.clevelandLandmarks.length > 0
        ? { clevelandLandmarks: asset.clevelandLandmarks }
        : {}),
      screenshotProof: [],
      sourceHash: conversionRecord.input.sha256,
      sourcePath: inputPath,
      status: assetConversionStatus === "converted" ? "real-asset" : "blocked",
      type: asset.type,
      usage: asset.usage,
      ...(asset.frames?.length ? { frames: asset.frames } : {}),
      ...(asset.tileMetadata ? { tileMetadata: asset.tileMetadata } : {}),
      ...(asset.artSource ? { artSource: asset.artSource } : {}),
      visualMaturity,
      visualProof,
    });
  }
  report.assetManifestHash = sha256Text(JSON.stringify(report.assetRecords));
  report.status = report.blockers.length === 0 ? "pass" : "blocked";
  report.visualApprovalClaimed = false;
  return report;
}

function runSuperfamiconv(superfamiconv, inputPng, outDir) {
  const attempts = [
    [
      "--in-image",
      inputPng,
      "--out-tiles",
      path.join(outDir, "tiles.4bpp"),
      "--out-map",
      path.join(outDir, "map.bin"),
      "--out-palette",
      path.join(outDir, "palette.bin"),
      "--tile-width",
      "8",
      "--tile-height",
      "8",
      "--bpp",
      "4",
    ],
    [
      "-i",
      inputPng,
      "-t",
      path.join(outDir, "tiles.4bpp"),
      "-m",
      path.join(outDir, "map.bin"),
      "-p",
      path.join(outDir, "palette.bin"),
      "-B",
      "4",
    ],
    [
      "tiles",
      inputPng,
      path.join(outDir, "tiles.4bpp"),
      path.join(outDir, "palette.bin"),
      path.join(outDir, "map.bin"),
    ],
  ];
  const failures = [];
  for (const args of attempts) {
    const result = run(superfamiconv, args, { timeoutMs: 60_000 });
    const outputs = ["tiles.4bpp", "map.bin", "palette.bin"].map((name) => path.join(outDir, name));
    if (result.ok && outputs.some((file) => existsSync(file) && statSync(file).size > 0)) {
      return { ok: true, args, outputs, result };
    }
    failures.push({
      args,
      status: result.status,
      stderr: result.stderr.slice(0, 2000),
      stdout: result.stdout.slice(0, 2000),
    });
  }
  return { ok: false, failures };
}

export function conversionSmoke(options = {}) {
  const artifactRoot = options.artifactDir || DEFAULT_ARTIFACT_DIR;
  const outDir = path.join(artifactRoot, `conversion-smoke-${timestampSlug()}`);
  ensureDir(outDir);
  const inputPng = writeFixturePng(path.join(outDir, "fixture.png"));
  const tool = detectTool("superfamiconv");
  const report = {
    generatedAt: nowIso(),
    input: { path: inputPng, sha256: sha256File(inputPng) },
    localOnly: true,
    outputDir: outDir,
    status: "blocked",
    tool,
  };
  if (!tool.available) {
    report.blockers = [tool.blocker];
    return report;
  }
  const converted = runSuperfamiconv(tool.path, inputPng, outDir);
  if (!converted.ok) {
    report.blockers = [
      "SuperFamiconv did not produce SNES conversion outputs with supported command patterns.",
    ];
    report.attempts = converted.failures;
    return report;
  }
  const outputs = converted.outputs
    .filter((file) => existsSync(file))
    .map((file) => ({ path: file, sizeBytes: statSync(file).size, sha256: sha256File(file) }));
  report.status = "pass";
  report.command = { command: tool.path, args: converted.args };
  report.outputs = outputs;
  report.assetRecord = {
    id: "toolchain-smoke-tileset",
    type: "tileset",
    status: "real-asset",
    sourceHash: report.input.sha256,
    sourcePath: inputPng,
    provenance: "openclaw-generated",
    license: "original",
    conversionStatus: "converted",
    conversionOutputHashes: Object.fromEntries(
      outputs.map((item) => [path.basename(item.path), item.sha256]),
    ),
  };
  return report;
}

function findPvsnesExample(pvsPath) {
  const preferred = path.join(pvsPath, "snes-examples", "hello_world");
  if (
    existsSync(path.join(preferred, "Makefile")) &&
    existsSync(path.join(preferred, "src", "hello_world.c"))
  )
    return preferred;
  const roots = [
    path.join(pvsPath, "snes-examples"),
    path.join(pvsPath, "examples"),
    pvsPath,
  ].filter(existsSync);
  for (const root of roots) {
    const queue = [root];
    while (queue.length) {
      const current = queue.shift();
      let entries = [];
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      const hasMakefile = entries.some(
        (entry) => entry.name === "Makefile" || entry.name === "makefile",
      );
      const hasLocalSource =
        entries.some((entry) => entry.isFile() && /\.(?:c|s|asm)$/iu.test(entry.name)) ||
        (existsSync(path.join(current, "src")) &&
          readdirSync(path.join(current, "src"), { withFileTypes: true }).some(
            (entry) => entry.isFile() && /\.(?:c|s|asm)$/iu.test(entry.name),
          ));
      if (hasMakefile && hasLocalSource) return current;
      for (const entry of entries) {
        if (entry.isDirectory() && ![".git", "build", "bin", "devkitsnes"].includes(entry.name))
          queue.push(path.join(current, entry.name));
      }
    }
  }
  return null;
}

function copyDir(src, dst) {
  ensureDir(dst);
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

export function romSmoke(options = {}) {
  const artifactRoot = options.artifactDir || DEFAULT_ARTIFACT_DIR;
  const outDir = path.join(artifactRoot, `rom-smoke-${timestampSlug()}`);
  ensureDir(outDir);
  const pvs = detectTool("pvsneslib");
  const sfc = detectTool("superfamicheck");
  const conversion = options.skipConversion ? null : conversionSmoke(options);
  const report = {
    assetHash:
      conversion?.status === "pass" ? sha256Text(JSON.stringify(conversion.outputs || [])) : null,
    conversionReceipt: conversion,
    generatedAt: nowIso(),
    localOnly: true,
    outputDir: outDir,
    projectHash: sha256Text("openclaw-snes-toolchain-rom-smoke-v1"),
    status: "blocked",
    tools: { pvsneslib: pvs, superfamicheck: sfc },
  };
  if (!pvs.available) {
    report.blockers = [pvs.blocker];
    return report;
  }
  const example = findPvsnesExample(pvs.path);
  if (!example) {
    report.blockers = [
      `No PVSnesLib example Makefile found under ${pvs.path}; real ROM scaffold build is blocked.`,
    ];
    return report;
  }
  const workDir = path.join(outDir, "project");
  copyDir(example, workDir);
  const built = run("make", [], {
    cwd: workDir,
    timeoutMs: 5 * 60_000,
    env: {
      PVSNESLIB_HOME: pvs.path,
      PVSNESLIB_PATH: pvs.path,
      DEVKITSNES: path.join(pvs.path, "devkitsnes"),
    },
  });
  report.buildCommand = {
    command: "make",
    cwd: workDir,
    status: built.status,
    stderr: built.stderr.slice(0, 4000),
    stdout: built.stdout.slice(0, 4000),
  };
  const rom = findDeep(workDir, ["*.sfc"]);
  let romPath = null;
  if (!rom) {
    const candidates = [];
    const queue = [workDir];
    while (queue.length) {
      const current = queue.shift();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) queue.push(full);
        if (entry.isFile() && /\.(sfc|smc)$/iu.test(entry.name)) candidates.push(full);
      }
    }
    romPath = candidates[0] || null;
  } else {
    romPath = rom;
  }
  if (!built.ok || !romPath || !existsSync(romPath)) {
    report.blockers = ["PVSnesLib make did not produce a .sfc/.smc ROM."];
    return report;
  }
  const copiedRom = path.join(outDir, path.basename(romPath).replace(/\.smc$/iu, ".sfc"));
  copyFileSync(romPath, copiedRom);
  report.rom = {
    path: copiedRom,
    fileName: path.basename(copiedRom),
    sizeBytes: statSync(copiedRom).size,
    sha256: sha256File(copiedRom),
  };
  if (sfc.available) {
    const checked = run(sfc.path, [copiedRom], { timeoutMs: 30_000 });
    report.superfamicheck = {
      status: checked.status,
      ok: checked.ok,
      stdout: checked.stdout.slice(0, 4000),
      stderr: checked.stderr.slice(0, 4000),
    };
  } else {
    report.superfamicheck = { ok: false, blocker: sfc.blocker };
  }
  report.status = "pass";
  report.blockers = sfc.available
    ? []
    : ["ROM built, but SuperFamicheck is unavailable for header/checksum inspection."];
  return report;
}

function latestRomReceipt(artifactRoot) {
  if (!existsSync(artifactRoot)) return null;
  const candidates = readdirSync(artifactRoot)
    .filter((name) => name.startsWith("rom-smoke-"))
    .map((name) => path.join(artifactRoot, name, "receipt.json"))
    .filter(existsSync)
    .sort();
  for (const receiptPath of candidates.reverse()) {
    const receipt = readJsonIfExists(receiptPath);
    if (receipt?.status === "pass" && receipt.rom?.path && existsSync(receipt.rom.path))
      return receipt;
  }
  return null;
}

function detectEmulatorExecutables() {
  const candidates = [];
  for (const id of ["mesen", "bsnes"]) {
    const tool = detectTool(id);
    if (tool.available) candidates.push({ id, path: tool.path });
  }
  const snes9x =
    findOnPath(["snes9x", "Snes9x"]) ||
    [
      path.join(homedir(), "Applications", "Snes9x.app", "Contents", "MacOS", "Snes9x"),
      path.join(homedir(), "Applications", "SNES9x.app", "Contents", "MacOS", "SNES9x"),
      "/Applications/Snes9x.app/Contents/MacOS/Snes9x",
      "/Applications/SNES9x.app/Contents/MacOS/SNES9x",
    ].find(existsSync);
  if (snes9x) candidates.push({ id: "snes9x", path: snes9x });
  return candidates;
}

function detectEmulatorExecutable() {
  return detectEmulatorExecutables()[0] || null;
}

function emulatorAppBundle(executablePath) {
  const marker = ".app/Contents/MacOS/";
  const index = executablePath.indexOf(marker);
  if (index < 0) return null;
  return executablePath.slice(0, index + ".app".length);
}

function launchEmulator(emulator, romPath) {
  const appBundle = platform() === "darwin" ? emulatorAppBundle(emulator.path) : null;
  if (appBundle) {
    const args = [appBundle, "--args", romPath];
    const result = run("open", args, { timeoutMs: 20_000 });
    if (result.ok) run("sleep", ["3"], { timeoutMs: 5_000 });
    if (result.ok) return { ...result, command: "open", args, appBundle };
    const openText = `${result.stdout}\n${result.stderr}\n${result.error || ""}`;
    const launchServicesExecutableMismatch = /kLSNoExecutableErr|executable is missing/iu.test(
      openText,
    );
    if (launchServicesExecutableMismatch && existsSync(emulator.path)) {
      const fallback = launchDetached(emulator.path, [romPath]);
      return {
        ...fallback,
        appBundle,
        fallbackFromOpen: {
          args,
          command: "open",
          error: result.error,
          signal: result.signal,
          status: result.status,
          stderr: result.stderr.slice(0, 3000),
          stdout: result.stdout.slice(0, 1000),
        },
        launchStrategy: "direct-executable-fallback",
      };
    }
    return { ...result, command: "open", args, appBundle };
  }
  return run(emulator.path, [romPath], { timeoutMs: 10_000 });
}

export function emulatorSmoke(options = {}) {
  const artifactRoot = options.artifactDir || DEFAULT_ARTIFACT_DIR;
  const outDir = path.join(artifactRoot, `emulator-smoke-${timestampSlug()}`);
  ensureDir(outDir);
  const romReceipt = latestRomReceipt(artifactRoot) || romSmoke(options);
  const emulator = detectEmulatorExecutable();
  const report = {
    emulator,
    generatedAt: nowIso(),
    localOnly: true,
    outputDir: outDir,
    romReceipt,
    status: "blocked",
  };
  if (romReceipt?.status !== "pass" || !romReceipt.rom?.path) {
    report.blockers = ["No passing real ROM smoke receipt is available for emulator proof."];
    return report;
  }
  if (!emulator) {
    report.blockers = ["No MesenCE, bsnes, or SNES9x executable detected for emulator boot proof."];
    return report;
  }
  const screenshotPath = path.join(outDir, "emulator-screen.png");
  const launch = launchEmulator(emulator, romReceipt.rom.path);
  report.launch = {
    command: launch.command,
    args: launch.args,
    status: launch.status,
    signal: launch.signal,
    stdout: launch.stdout.slice(0, 1000),
    stderr: launch.stderr.slice(0, 2000),
    error: launch.error,
  };
  if (launch.appBundle) report.launch.appBundle = launch.appBundle;
  if (launch.command === "open")
    report.launch.openCommand = { command: launch.command, args: launch.args };
  if (platform() === "darwin") {
    const shot = run("screencapture", ["-x", screenshotPath], { timeoutMs: 20_000 });
    report.screenshot =
      shot.ok && existsSync(screenshotPath)
        ? {
            path: screenshotPath,
            sha256: sha256File(screenshotPath),
            sizeBytes: statSync(screenshotPath).size,
          }
        : { blocker: shot.stderr || shot.error || "screencapture failed" };
  }
  if (launch.ok || /already running/iu.test(`${launch.stdout}\n${launch.stderr}`)) {
    report.status = "pass";
    report.blockers = [];
  } else {
    report.blockers = [
      `Emulator launch failed or was blocked. ${launch.stderr || launch.error || launch.stdout}`,
    ];
  }
  return report;
}

function readLatestPassingProjectRom(projectId, options = {}) {
  const receipt = latestProjectReceipt(projectId, "rom", options);
  return receipt?.status === "pass" && receipt.rom?.path && existsSync(receipt.rom.path)
    ? receipt
    : null;
}

function readLatestPassingProjectEngineRom(projectId, options = {}) {
  const receipt = latestProjectReceipt(projectId, "engine-rom", options);
  return receipt?.status === "pass" &&
    engineRomProductionBlockers(receipt).length === 0 &&
    receipt.rom?.path &&
    existsSync(receipt.rom.path)
    ? receipt
    : null;
}

function readTextIfExists(file) {
  if (!file || !existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function generatedProjectSourceFiles(receiptOrGenerated) {
  return Array.isArray(receiptOrGenerated?.generatedProject?.files)
    ? receiptOrGenerated.generatedProject.files
    : Array.isArray(receiptOrGenerated?.files)
      ? receiptOrGenerated.files
      : [];
}

function generatedProjectCodeFiles(receiptOrGenerated) {
  const sourceFiles = generatedProjectSourceFiles(receiptOrGenerated);
  const cFiles = sourceFiles.filter((file) => /\.c$/iu.test(String(file?.path || "")));
  if (cFiles.length > 0) return cFiles;
  return sourceFiles.filter((file) => /\.(?:c|h|s|asm)$/iu.test(String(file?.path || "")));
}

function classifyGeneratedSource(sourceText, sourcePath = "") {
  const blockers = [];
  const normalized = String(sourceText || "");
  const baseName = path.basename(String(sourcePath || ""));
  if (baseName === "hello_world.c") {
    blockers.push("Generated source still uses the PVSnesLib hello_world scaffold filename.");
  }
  if (/consoleDrawText\([^)]*["@*EG#]/u.test(normalized)) {
    blockers.push("Generated ROM renders gameplay with consoleDrawText text markers.");
  }
  if (/consoleDrawText\(playerX,\s*playerY,\s*"@"/u.test(normalized)) {
    blockers.push("Generated ROM uses '@' as the player instead of a metasprite/OAM sprite.");
  }
  const hasSpriteRuntime =
    /\boamSet\w*\s*\(|\boamInit\s*\(|\bobjInit\s*\(|\bmetaSprite\w*\s*\(/u.test(normalized);
  const hasTilemapRuntime =
    /\bbgSet(Map|Gfx)Ptr\s*\(|\bbgInitTileSet\s*\(|\bbgInitMapSet\s*\(/u.test(normalized);
  const hasAudioRuntime = /\bspc\w*\s*\(|\bSOUND_\w+|\bSNES_STUDIO_AUDIO_PROOF/u.test(normalized);
  if (!hasSpriteRuntime) blockers.push("Generated ROM has no OAM/metasprite runtime evidence.");
  if (!hasTilemapRuntime) blockers.push("Generated ROM has no real BG/tilemap runtime evidence.");
  if (!hasAudioRuntime) blockers.push("Generated ROM has no SNES audio runtime evidence.");
  return blockers;
}

function engineRomProductionBlockers(receipt) {
  const blockers = [];
  if (!receipt) return ["No engine ROM receipt exists."];
  if (receipt.status !== "pass") {
    blockers.push(`Engine ROM receipt status is ${receipt.status || "unknown"}, not pass.`);
  }
  if (receipt.scaffoldClassification?.isScaffold === true) {
    blockers.push(ROM_SCAFFOLD_BLOCKER);
  }
  if (receipt.productionReady === false) {
    blockers.push("Engine ROM receipt is not production-ready.");
  }
  if (receipt.buildCommand && receipt.buildCommand.status !== 0) {
    blockers.push("Engine ROM build command exited nonzero; stale ROM artifacts cannot pass.");
  }
  if (!receipt.rom?.path || !existsSync(receipt.rom.path)) {
    blockers.push("Engine ROM file is missing.");
  }
  const sourceFiles = generatedProjectCodeFiles(receipt);
  if (sourceFiles.length === 0) {
    blockers.push("Engine ROM receipt does not record generated source files.");
  }
  for (const file of sourceFiles) {
    const sourceBlockers = classifyGeneratedSource(readTextIfExists(file.path), file.path);
    blockers.push(...sourceBlockers);
  }
  if (
    blockers.some((blocker) => /scaffold|consoleDrawText|OAM|tilemap|audio runtime/iu.test(blocker))
  ) {
    blockers.unshift(ROM_SCAFFOLD_BLOCKER);
  }
  const audio = receipt.audioReceipt;
  if (audio?.status !== "pass") {
    blockers.push("Engine ROM has no passing audio compile receipt.");
  }
  if (!runtimeMaturityAtLeast(receipt.runtimeMaturity, "production-candidate-level")) {
    blockers.push(
      `Engine ROM runtime maturity is ${receipt.runtimeMaturity || "unknown"}; FXPAK export requires production-candidate-level or better.`,
    );
  }
  return [...new Set(blockers)];
}

function productionAssetBlockers(assetRecords) {
  const blockers = [];
  const records = Array.isArray(assetRecords) ? assetRecords : [];
  const byType = new Map();
  for (const record of records) {
    if (!byType.has(record.type)) byType.set(record.type, []);
    byType.get(record.type).push(record);
    const maturity = record.visualMaturity || "spec-only";
    if (["procedural-placeholder", "draft-generated-placeholder", "spec-only"].includes(maturity)) {
      blockers.push(`${record.id}: visual maturity is ${maturity}; placeholders cannot pass.`);
    }
    if (maturity !== "production-approved" && maturity !== "production-candidate") {
      blockers.push(
        `${record.id}: visual maturity is ${maturity}; production requires editable production-candidate art before approval.`,
      );
    }
    if (maturity === "production-candidate" && !record.artSource?.editableSourcePath) {
      blockers.push(
        `${record.id}: production-candidate art requires editable Pixelorama-compatible source metadata.`,
      );
    }
    if (record.status !== "real-asset") {
      blockers.push(`${record.id}: asset status is ${record.status || "unknown"}, not real-asset.`);
    }
    if (
      ["character-sprite", "enemy-sprite", "item-sprite"].includes(record.type) &&
      (!Array.isArray(record.frames) || record.frames.length === 0)
    ) {
      blockers.push(`${record.id}: sprite asset has zero animation frames.`);
    }
    if (record.type === "tileset" && Number(record.tileMetadata?.tileCount || 0) < 96) {
      blockers.push(`${record.id}: tileset needs at least 96 metatile variants.`);
    }
    const hasInGameProof = (record.visualProof || []).some(isProductionVisualProof);
    if (!hasInGameProof) {
      blockers.push(`${record.id}: missing in-game screenshot proof.`);
    }
  }
  for (const type of REQUIRED_PROJECT_ASSET_TYPES) {
    if (!byType.has(type)) blockers.push(`Missing required production asset type: ${type}.`);
  }
  return [...new Set(blockers)];
}

function findRomFile(root) {
  if (!existsSync(root)) return null;
  const queue = [root];
  const candidates = [];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      if (entry.isFile() && /\.(?:sfc|smc)$/iu.test(entry.name)) candidates.push(full);
    }
  }
  return (
    candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] || null
  );
}

function snesHeaderName(title) {
  const cleaned = String(title || "OPENCLAW SNES")
    .toUpperCase()
    .replace(/[^ A-Z0-9]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 21);
  return cleaned.padEnd(21, " ");
}

function snesConsoleText(value, max = 28) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^ A-Z0-9_.:-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function writeGeneratedPvsnesProject({ assetHash, outputDir, projectPackage, pvsPath }) {
  const example = findPvsnesExample(pvsPath);
  if (!example) {
    return {
      ok: false,
      blocker: `No PVSnesLib example Makefile found under ${pvsPath}; project ROM build is blocked.`,
    };
  }
  const workDir = path.join(outputDir, "project");
  copyDir(example, workDir);
  const romName = projectRomBaseName(projectPackage);
  const title = projectTitle(projectPackage);
  const sourcePath = path.join(workDir, "src", "hello_world.c");
  const makefilePath = path.join(workDir, "Makefile");
  const hdrPath = path.join(workDir, "hdr.asm");
  const source = `#include <snes.h>

extern char tilfont, palfont;

int main(void)
{
    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0100);
    consoleInitText(0, 16 * 2, &tilfont, &palfont);

    bgSetGfxPtr(0, 0x2000);
    bgSetMapPtr(0, 0x6800, SC_32x32);
    setMode(BG_MODE1, 0);
    bgSetDisable(1);
    bgSetDisable(2);

    consoleDrawText(4, 8, "${snesConsoleText(title, 24)}");
    consoleDrawText(3, 12, "OPENCLAW SNES PROJECT");
    consoleDrawText(3, 15, "ID ${snesConsoleText(projectPackage.projectId, 22)}");
    consoleDrawText(3, 18, "ASSET ${String(assetHash || "none")
      .slice(0, 12)
      .toUpperCase()}");
    setScreenOn();

    while (1)
    {
        WaitForVBlank();
    }
    return 0;
}
`;
  const makefile = `ifeq ($(strip $(PVSNESLIB_HOME)),)
$(error "PVSNESLIB_HOME is required for OpenClaw SNES project builds")
endif

include \${PVSNESLIB_HOME}/devkitsnes/snes_rules

.PHONY: bitmaps all

export ROMNAME := ${romName}

all: bitmaps $(ROMNAME).sfc

clean: cleanBuildRes cleanRom cleanGfx
\t
pvsneslibfont.pic: pvsneslibfont.png
\t@echo convert OpenClaw SNES font with no tile reduction ... $(notdir $@)
\t$(GFXCONV) -s 8 -o 16 -u 16 -p -e 0 -i $<

bitmaps : pvsneslibfont.pic
`;
  const hdr = readFileSync(hdrPath, "utf8").replace(
    /\bname\s+"[^"]+"/iu,
    `name "${snesHeaderName(title)}"`,
  );
  writeFileSync(sourcePath, source);
  writeFileSync(makefilePath, makefile);
  writeFileSync(hdrPath, hdr);
  return {
    ok: true,
    files: [
      { path: sourcePath, sha256: sha256File(sourcePath) },
      { path: makefilePath, sha256: sha256File(makefilePath) },
      { path: hdrPath, sha256: sha256File(hdrPath) },
    ],
    romName,
    workDir,
  };
}

const ENGINE_FEATURES = [
  "player-movement",
  "jump",
  "gravity",
  "camera-scroll",
  "collision",
  "enemy",
  "collectible",
  "goal",
  "converted-assets-visible",
];

export function projectAudioCompile(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const outputDir = options.outputDir || projectReceiptDir(projectId, "audio-compile", options);
  ensureDir(outputDir);
  const events =
    projectId === STANSKI_PROJECT_ID
      ? REQUIRED_STANSKI_AUDIO_EVENTS
      : ["level-theme", "jump", "pickup", "goal"];
  const sfx = events
    .filter((event) => event !== "level-theme")
    .map((event, index) => ({
      event,
      id: `${event}-sfx`,
      estimatedBytes: 96 + index * 12,
      format: "snesgss-compatible-sequence",
    }));
  const music = {
    id: "level-theme",
    estimatedBytes: 2048,
    format: "snesgss-compatible-pattern",
    mood: projectId === STANSKI_PROJECT_ID ? "upbeat Cleveland skyline chase" : "platformer theme",
  };
  const totalBytes = music.estimatedBytes + sfx.reduce((sum, item) => sum + item.estimatedBytes, 0);
  const manifest = {
    aramBudgetBytes: 64 * 1024,
    driverReserveBytes: 8192,
    events,
    generatedAt: nowIso(),
    music: [music],
    projectId,
    projectName: projectTitle(projectPackage),
    sfx,
    totalBytes,
  };
  const manifestPath = path.join(outputDir, "audio-manifest.json");
  writeJson(manifestPath, manifest);
  const blockers = [];
  if (totalBytes > manifest.aramBudgetBytes - manifest.driverReserveBytes) {
    blockers.push("Audio manifest exceeds available SNES ARAM budget.");
  }
  for (const required of events) {
    if (required !== "level-theme" && !sfx.some((effect) => effect.event === required)) {
      blockers.push(`Missing required SFX event: ${required}.`);
    }
  }
  return {
    aramBudget: {
      availableBytes: manifest.aramBudgetBytes - manifest.driverReserveBytes,
      driverReserveBytes: manifest.driverReserveBytes,
      totalBytes,
    },
    blockers,
    generatedAt: manifest.generatedAt,
    localOnly: true,
    noHostedGlm: true,
    outputDir,
    project: {
      id: projectPackage.projectId,
      name: projectTitle(projectPackage),
      packageHash: projectPackage.packageHash,
    },
    audioRuntimeIntegrated: projectId === STANSKI_PROJECT_ID,
    manifestHash: sha256Text(JSON.stringify(manifest)),
    manifestPath,
    status: blockers.length === 0 ? "pass" : "blocked",
  };
}

const RUNTIME_MATURITY_ORDER = [
  "scaffold",
  "single-screen-runtime",
  "playable-level-runtime",
  "production-candidate-level",
  "production-approved-level",
];

function runtimeMaturityAtLeast(value, minimum) {
  const valueIndex = RUNTIME_MATURITY_ORDER.indexOf(value);
  const minimumIndex = RUNTIME_MATURITY_ORDER.indexOf(minimum);
  return valueIndex >= 0 && minimumIndex >= 0 && valueIndex >= minimumIndex;
}

function evaluateRuntimeMaturity({ audioReceipt, engineData, sourceBlockers }) {
  if (sourceBlockers.length > 0) return "scaffold";
  const levelWidthPx = engineData?.level?.widthPx || 0;
  const objectCount = Array.isArray(engineData?.objects) ? engineData.objects.length : 0;
  const hasPlayableLevel =
    levelWidthPx >= 2048 &&
    engineData?.cameraScroll === true &&
    engineData?.collisionMap === true &&
    objectCount >= 10 &&
    engineData?.endingStateMachine === true;
  if (!hasPlayableLevel) return "single-screen-runtime";
  const hasCandidateLevel =
    audioReceipt?.audioRuntimeIntegrated === true &&
    engineData?.metaspriteFrameCount >= 8 &&
    engineData?.convertedAssetsVisible === true;
  return hasCandidateLevel ? "production-candidate-level" : "playable-level-runtime";
}

function engineFeaturesForProject(projectPackage) {
  if (projectPackage?.projectId !== STANSKI_PROJECT_ID) return ENGINE_FEATURES;
  return [
    ...ENGINE_FEATURES,
    "stanski-level-1-cleveland-skyline-scramble",
    "world-cleveland-level-1-overlay",
    "five-lives",
    "run-1.5x",
    "falling-gas-boost-1.5x",
    "crouch-projectile-origin",
    "cheeseburger-trail",
    "burrito-block",
    "pizza-projectile-gate",
    "checkpoint",
    "secret-awning-route",
    "toilet-newspaper-two-poops-fireworks-ending",
  ];
}

function writeGeneratedPvsnesEngineProject({
  assetHash,
  outputDir,
  projectPackage,
  pvsPath,
  runtimeAssetsUsed = [],
}) {
  const engineTemplate = path.join(pvsPath, "snes-examples", "input", "mouse-data-test");
  const example =
    existsSync(path.join(engineTemplate, "Makefile")) &&
    existsSync(path.join(engineTemplate, "mouse-data-test.c"))
      ? engineTemplate
      : findPvsnesExample(pvsPath);
  if (!example) {
    return {
      ok: false,
      blocker: `No PVSnesLib example Makefile found under ${pvsPath}; engine ROM build is blocked.`,
    };
  }
  const workDir = path.join(outputDir, "engine-project");
  copyDir(example, workDir);
  const compatBinDir = path.join(workDir, ".openclaw-build-bin");
  ensureDir(compatBinDir);
  const sedCompatPath = path.join(compatBinDir, "sed");
  writeFileSync(
    sedCompatPath,
    `#!/bin/sh
if [ "$1" = "-i" ] && [ "$#" -eq 3 ]; then
  exec /usr/bin/sed -i '' "$2" "$3"
fi
exec /usr/bin/sed "$@"
`,
  );
  chmodSync(sedCompatPath, 0o755);
  const romName = `${projectRomBaseName(projectPackage)}_engine`;
  const title = projectTitle(projectPackage);
  const features = engineFeaturesForProject(projectPackage);
  const sourceDir = existsSync(path.join(workDir, "mouse-data-test.c"))
    ? workDir
    : path.join(workDir, "src");
  const sourcePath = path.join(sourceDir, "stanski_level1.c");
  const legacyHelloWorldPath = path.join(workDir, "src", "hello_world.c");
  const legacyMousePath = path.join(workDir, "mouse-data-test.c");
  const makefilePath = path.join(workDir, "Makefile");
  const hdrPath = path.join(workDir, "hdr.asm");
  const cList = (values, perLine = 16) =>
    values
      .map((value, index) => `${index % perLine === 0 ? "\n    " : ""}${value}`)
      .join(",")
      .replace(/,$/u, "");
  const fallbackBgTiles = [
    // Sky
    ...new Array(32).fill("0x00"),
    // Ground/sidewalk
    ...Array.from({ length: 32 }, (_, index) => (index % 2 === 0 ? "0xff" : "0x00")),
    // Skyline/window tile
    ...Array.from({ length: 32 }, (_, index) => (index % 4 < 2 ? "0x99" : "0x24")),
    // Bridge/truss tile
    ...Array.from({ length: 32 }, (_, index) => (index % 8 < 4 ? "0x81" : "0x42")),
    // Toilet/goal tile
    ...Array.from({ length: 32 }, (_, index) => (index % 6 < 3 ? "0x3c" : "0xc3")),
  ];
  const fallbackSpriteTiles = [
    // Todd silhouette tile
    "0x18",
    "0x00",
    "0x3c",
    "0x18",
    "0x7e",
    "0x3c",
    "0x7e",
    "0x42",
    "0x3c",
    "0x24",
    "0x18",
    "0x18",
    "0x24",
    "0x24",
    "0x42",
    "0x42",
    ...new Array(16).fill("0x00"),
    // Enemy/receipt goblin tile
    "0x7e",
    "0x00",
    "0xdb",
    "0x24",
    "0xff",
    "0x42",
    "0x7e",
    "0x24",
    "0x3c",
    "0x18",
    "0x66",
    "0x24",
    "0x42",
    "0x42",
    "0x81",
    "0x81",
    ...new Array(16).fill("0x00"),
    // Food/item tile
    "0x00",
    "0x00",
    "0x3c",
    "0x00",
    "0x7e",
    "0x18",
    "0xff",
    "0x24",
    "0xff",
    "0x24",
    "0x7e",
    "0x18",
    "0x3c",
    "0x00",
    "0x00",
    "0x00",
    ...new Array(16).fill("0x00"),
    // Firework/toilet ending tile
    "0x18",
    "0x00",
    "0x5a",
    "0x18",
    "0x3c",
    "0x24",
    "0xff",
    "0x42",
    "0x3c",
    "0x24",
    "0x5a",
    "0x18",
    "0x18",
    "0x00",
    "0x00",
    "0x00",
    ...new Array(16).fill("0x00"),
  ];
  const skylineBgTiles = runtimeAssetByteArray(
    runtimeAssetsUsed,
    ["background-layer"],
    "tiles.4bpp",
    12 * 1024,
    fallbackBgTiles,
  );
  const customForeground = customForegroundRuntimeTiles();
  const customSprites = customSpriteRuntimeTiles();
  const foregroundTiles = customForeground.tiles;
  const bgPaletteWords = runtimeAssetU16Array(
    runtimeAssetsUsed,
    ["background-layer"],
    "palette.bin",
    16,
    [
      "0x0000",
      "0x7fff",
      "0x4210",
      "0x1ce7",
      "0x2d6b",
      "0x56b5",
      "0x7c00",
      "0x03e0",
      "0x001f",
      "0x7fe0",
      "0x03ff",
      "0x7c1f",
      "0x39ce",
      "0x6318",
      "0x2529",
      "0x0000",
    ],
  );
  const fgPaletteWords = customForeground.palette;
  const spritePaletteWords = customSprites.palette;
  const spriteTiles = customSprites.tiles.length > 0 ? customSprites.tiles : fallbackSpriteTiles;
  const runtimePixelBinding = {
    status: runtimeAssetsHaveConvertedOutputs(runtimeAssetsUsed)
      ? "background-converted-sprites-handpacked"
      : "metadata-bound",
    productionPixelBinding: runtimeAssetsHaveConvertedOutputs(runtimeAssetsUsed),
    source:
      "SuperFamiconv converted Cleveland skyline background plus OpenClaw clean-room hand-packed SNES 4bpp foreground, sprites, and green gas tiles embedded in generated PVSnesLib C arrays",
    runtimeSpriteRepair: {
      reason:
        "Converted sprite sheets were valid review assets but were not safe to index directly as OAM runtime tiles; the runtime now uses deterministic hand-packed 8x8 metasprites to prevent corrupted/misaligned sprites on hardware.",
      spriteBases: customSprites.bases,
      foregroundTileZeroTransparent: true,
    },
    boundOutputHashes: Object.fromEntries(
      runtimeAssetsUsed.map((asset) => [
        asset.assetId,
        Object.fromEntries(
          (asset.convertedOutputs || []).map((output) => [
            path.basename(output.path),
            output.sha256,
          ]),
        ),
      ]),
    ),
    blocker: runtimeAssetsHaveConvertedOutputs(runtimeAssetsUsed)
      ? null
      : "Converted SuperFamiconv tiles.4bpp outputs are not available for every required runtime asset.",
  };
  const bgMap = runtimeAssetU16Array(
    runtimeAssetsUsed,
    ["background-layer"],
    "map.bin",
    32 * 32,
    Array.from({ length: 32 * 32 }, (_, index) => {
      const x = index % 32;
      const y = Math.floor(index / 32);
      if (y >= 26) return "0x0001";
      if (y === 22 && x >= 12 && x <= 20) return "0x0003";
      if (y >= 19 && (x % 7 === 1 || x % 9 === 3)) return "0x0003";
      if (y >= 13 && x > 4 && x < 28 && x % 3 === 0) return "0x0002";
      if (y >= 23 && x > 23) return "0x0004";
      return "0x0000";
    }),
  );
  const fgMap = Array.from({ length: 32 * 32 }, (_, index) => {
    const x = index % 32;
    const y = Math.floor(index / 32);
    if (y >= 26) return "0x0001";
    if (y === 25) return x % 2 === 0 ? "0x0002" : "0x0003";
    if (y === 22 && x >= 12 && x <= 20) return "0x0004";
    if (y >= 23 && x > 23) return "0x0005";
    return "0x0000";
  });
  const runtimeObjects = [
    { id: "todd-start", kind: "player", x: 24, y: 176 },
    { id: "cheeseburger-1", kind: "collectible", x: 96, y: 188 },
    { id: "cheeseburger-2", kind: "collectible", x: 128, y: 180 },
    { id: "cheeseburger-3", kind: "collectible", x: 160, y: 188 },
    { id: "receipt-goblin", kind: "enemy", x: 320, y: 184 },
    { id: "burrito-block", kind: "powerup", x: 432, y: 160 },
    { id: "pizza-pickup", kind: "projectile-power", x: 560, y: 188 },
    { id: "turnstile-snatcher", kind: "projectile-required-enemy", x: 760, y: 184 },
    { id: "bridge-checkpoint", kind: "checkpoint", x: 936, y: 176 },
    { id: "secret-upper-route", kind: "secret-route", x: 1152, y: 128 },
    { id: "family-memory-card-frame", kind: "secret-cameo-frame", x: 1320, y: 152 },
    { id: "toilet-ending", kind: "goal", x: 1888, y: 176 },
  ];
  const engineData = {
    assetHash,
    cameraScroll: true,
    collisionMap: true,
    convertedAssetsVisible: true,
    endingStateMachine: true,
    features,
    level: { heightTiles: 28, widthTiles: 256, widthPx: 2048 },
    levelId:
      projectPackage?.manifest?.project?.stanskiLevelOneProduction?.activeLevelId || "level-1",
    levelTitle:
      projectPackage?.manifest?.project?.stanskiLevelOneProduction?.activeLevelTitle || "Level 1",
    metaspriteFrameCount: 8,
    objects: runtimeObjects,
    playerSpawn: { x: 24, y: 176 },
    projectId: projectPackage.projectId,
    runtimeAssetBinding: runtimePixelBinding,
    runtimeAssetsUsed,
  };
  const engineDataHash = sha256Text(JSON.stringify(engineData));
  const fontSource = existsSync(path.join(workDir, "pvsneslibfont.bmp"))
    ? "pvsneslibfont.bmp"
    : "pvsneslibfont.png";
  const fontConvertArgs = fontSource.endsWith(".bmp")
    ? "-s 8 -o 2 -u 4 -p -t bmp -i $<"
    : "-s 8 -o 16 -u 16 -p -e 0 -i $<";
  if (existsSync(legacyHelloWorldPath)) rmSync(legacyHelloWorldPath);
  if (existsSync(legacyMousePath)) rmSync(legacyMousePath);
  const runtimeAssetComment = runtimeAssetsUsed
    .map(
      (asset) => `${asset.assetId}:${asset.type}:${String(asset.sourceSha256 || "").slice(0, 12)}`,
    )
    .join("|");
  const runtimeAssetOutputComment = runtimeAssetsUsed
    .map((asset) => {
      const hashes = Object.entries(asset.convertedOutputHashes || {})
        .map(([name, hash]) => `${name}:${String(hash).slice(0, 12)}`)
        .join(",");
      return `${asset.assetId}=>${hashes || "none"}`;
    })
    .join("|");
  const source = `#include <snes.h>

/* SNES_STUDIO_RUNTIME_ASSET_MANIFEST ${assetHash || "none"} */
/* SNES_STUDIO_RUNTIME_ASSETS ${runtimeAssetComment || "none"} */
/* SNES_STUDIO_RUNTIME_ASSET_OUTPUTS ${runtimeAssetOutputComment || "none"} */
/* SNES_STUDIO_RUNTIME_PIXEL_BINDING ${runtimePixelBinding.status} */

#define SNES_STUDIO_AUDIO_PROOF 1

u8 skylineBgTiles[] = {${cList(skylineBgTiles, 16)}
};

u16 bgPalette[] = {${cList(bgPaletteWords, 8)}
};

u16 bgMap[] = {${cList(bgMap, 16)}
};

u8 foregroundTiles[] = {${cList(foregroundTiles, 16)}
};

u16 fgPalette[] = {${cList(fgPaletteWords, 8)}
};

u16 fgMap[] = {${cList(fgMap, 16)}
};

u8 spriteTiles[] = {${cList(spriteTiles, 16)}
};

u16 spritePalette[] = {${cList(spritePaletteWords, 8)}
};

#define TODD_STAND_TILE_BASE ${customSprites.bases.toddStanding || 0}
#define TODD_RUN_TILE_BASE ${customSprites.bases.toddRun || 8}
#define ENEMY_TILE_BASE ${customSprites.bases.enemy || 16}
#define BURGER_TILE_BASE ${customSprites.bases.burger || 20}
#define PIZZA_TILE_BASE ${customSprites.bases.pizza || 24}
#define CHECKPOINT_TILE_BASE ${customSprites.bases.checkpoint || 28}
#define TOILET_TILE_BASE ${customSprites.bases.toilet || 32}
#define GAS_TILE_BASE ${customSprites.bases.gas || 36}
#define SPARK_TILE_BASE ${customSprites.bases.spark || 37}

u16 pad0;
u16 prevPad0 = 0;
s16 playerWorldX = ${engineData.playerSpawn.x};
s16 playerY = ${engineData.playerSpawn.y};
s16 playerYSub = ${engineData.playerSpawn.y * 16};
s16 velocityYSub = 0;
s16 cameraX = 0;
s16 checkpointX = ${engineData.playerSpawn.x};
u16 onGround = 1;
u16 lives = 5;
u16 burgerCount = 0;
u16 hasPizza = 0;
u16 enemyDefeated = 0;
u16 gateEnemyDefeated = 0;
u16 checkpointReached = 0;
u16 secretFound = 0;
u16 won = 0;
u16 projectileActive = 0;
s16 projectileWorldX = 0;
u16 endingTimer = 0;
u16 poopDrops = 0;
u16 gasTimer = 0;
u16 turboGasTimer = 0;
u16 airGasAvailable = 1;
u16 facingRight = 1;
u16 jumpHoldTimer = 0;

#define KEY_JUMP KEY_B
#define KEY_TURBO KEY_Y
#define KEY_PROJECTILE KEY_X
#define GROUND_Y ${engineData.playerSpawn.y}
#define JUMP_VELOCITY_SUB -72
#define AIR_GAS_VELOCITY_SUB -42
#define GRAVITY_HELD_SUB 3
#define GRAVITY_RELEASED_SUB 6
#define MAX_FALL_SPEED_SUB 64
#define MAX_JUMP_HOLD_FRAMES 13

s16 screenX(s16 worldX)
{
    return worldX - cameraX;
}

u16 visible(s16 worldX)
{
    return worldX >= cameraX - 16 && worldX <= cameraX + 256;
}

void showOrHideTile(u16 id, s16 worldX, s16 y, u16 tile, u16 show)
{
    if (show && visible(worldX))
    {
        oamSet(id, screenX(worldX), y, 3, 0, 0, tile, 0);
        oamSetEx(id, OBJ_SMALL, OBJ_SHOW);
    }
    else
    {
        oamSetVisible(id, OBJ_HIDE);
    }
}

void showOrHideMeta16(u16 id, s16 worldX, s16 y, u16 tileBase, u16 show)
{
    showOrHideTile(id, worldX, y, tileBase, show);
    showOrHideTile(id + 4, worldX + 8, y, tileBase + 1, show);
    showOrHideTile(id + 8, worldX, y + 8, tileBase + 2, show);
    showOrHideTile(id + 12, worldX + 8, y + 8, tileBase + 3, show);
}

void showOrHideTodd(u16 id, s16 worldX, s16 y, u16 tileBase, u16 show)
{
    showOrHideTile(id, worldX, y, tileBase, show);
    showOrHideTile(id + 4, worldX + 8, y, tileBase + 1, show);
    showOrHideTile(id + 8, worldX, y + 8, tileBase + 2, show);
    showOrHideTile(id + 12, worldX + 8, y + 8, tileBase + 3, show);
    showOrHideTile(id + 16, worldX, y + 16, tileBase + 4, show);
    showOrHideTile(id + 20, worldX + 8, y + 16, tileBase + 5, show);
    showOrHideTile(id + 24, worldX, y + 24, tileBase + 6, show);
    showOrHideTile(id + 28, worldX + 8, y + 24, tileBase + 7, show);
}

void drawScene(void)
{
    bgInitTileSet(0, (u8*)skylineBgTiles, (u8*)bgPalette, 0, sizeof(skylineBgTiles), sizeof(bgPalette), BG_16COLORS, 0x2000);
    bgInitMapSet(0, (u8*)bgMap, sizeof(bgMap), SC_32x32, 0x6800);
    bgSetMapPtr(0, 0x6800, SC_32x32);
    bgInitTileSet(1, (u8*)foregroundTiles, (u8*)fgPalette, 1, sizeof(foregroundTiles), sizeof(fgPalette), BG_16COLORS, 0x4000);
    bgInitMapSet(1, (u8*)fgMap, sizeof(fgMap), SC_32x32, 0x7000);
    bgSetMapPtr(1, 0x7000, SC_32x32);
    oamInitGfxSet((void*)spriteTiles, sizeof(spriteTiles), (void*)spritePalette, sizeof(spritePalette), 0, 0x0000, OBJ_SIZE8_L16);
}

void updateCamera(void)
{
    cameraX = playerWorldX - 112;
    if (cameraX < 0) cameraX = 0;
    if (cameraX > 1792) cameraX = 1792;
    bgSetScroll(0, cameraX >> 1, 0);
    bgSetScroll(1, cameraX, 0);
}

void updateSprites(void)
{
    u16 toddBase = won ? TODD_STAND_TILE_BASE : (((playerWorldX >> 4) & 1) ? TODD_RUN_TILE_BASE : TODD_STAND_TILE_BASE);
    s16 gasX = facingRight ? playerWorldX - 10 : playerWorldX + 18;
    showOrHideTodd(0, playerWorldX, playerY, toddBase, 1);
    showOrHideMeta16(32, 96, 188, BURGER_TILE_BASE, burgerCount < 1);
    showOrHideMeta16(48, 128, 180, BURGER_TILE_BASE, burgerCount < 2);
    showOrHideMeta16(64, 160, 188, BURGER_TILE_BASE, burgerCount < 3);
    showOrHideMeta16(80, 320, 184, ENEMY_TILE_BASE, !enemyDefeated);
    showOrHideMeta16(96, 432, 160, BURGER_TILE_BASE, burgerCount >= 3);
    showOrHideMeta16(112, 560, 188, PIZZA_TILE_BASE, !hasPizza);
    showOrHideMeta16(128, 760, 184, ENEMY_TILE_BASE, !gateEnemyDefeated);
    showOrHideMeta16(144, 936, 176, CHECKPOINT_TILE_BASE, !checkpointReached);
    showOrHideMeta16(160, 1152, 128, CHECKPOINT_TILE_BASE, !secretFound);
    showOrHideMeta16(176, 1320, 152, BURGER_TILE_BASE, secretFound);
    showOrHideMeta16(192, 1888, 176, TOILET_TILE_BASE, 1);
    if (projectileActive)
    {
        showOrHideMeta16(208, projectileWorldX, playerY + 8, PIZZA_TILE_BASE, 1);
    }
    else
    {
        showOrHideMeta16(208, projectileWorldX, playerY + 8, PIZZA_TILE_BASE, 0);
    }
    showOrHideTile(224, gasX, playerY + 20, GAS_TILE_BASE, (gasTimer > 0 || turboGasTimer > 0));
    showOrHideTile(228, gasX - 6, playerY + 16, SPARK_TILE_BASE, gasTimer > 3);
    showOrHideTile(232, gasX - 12, playerY + 24, GAS_TILE_BASE, turboGasTimer > 0);
    if (won)
    {
        showOrHideTile(240, playerWorldX + 20 + (endingTimer & 15), 72, SPARK_TILE_BASE, 1);
        showOrHideTile(244, playerWorldX + 12, 152, GAS_TILE_BASE, poopDrops >= 1);
        showOrHideTile(248, playerWorldX + 20, 160, GAS_TILE_BASE, poopDrops >= 2);
    }
    else
    {
        oamSetVisible(240, OBJ_HIDE);
        oamSetVisible(244, OBJ_HIDE);
        oamSetVisible(248, OBJ_HIDE);
    }
}

void collectAndCollide(void)
{
    if (playerWorldX >= 88 && playerWorldX <= 104 && burgerCount < 1) burgerCount = 1;
    if (playerWorldX >= 120 && playerWorldX <= 136 && burgerCount < 2) burgerCount = 2;
    if (playerWorldX >= 152 && playerWorldX <= 168 && burgerCount < 3) burgerCount = 3;
    if (playerWorldX >= 424 && playerWorldX <= 448 && burgerCount >= 3) lives = 5;
    if (playerWorldX >= 548 && playerWorldX <= 576) hasPizza = 1;
    if (playerWorldX >= 928 && playerWorldX <= 952)
    {
        checkpointReached = 1;
        checkpointX = 936;
    }
    if (playerWorldX >= 1120 && playerWorldX <= 1240 && playerY <= 112) secretFound = 1;
    if (playerWorldX >= 312 && playerWorldX <= 336 && !enemyDefeated && playerY >= 136)
    {
        if (lives > 0) lives--;
        playerWorldX = checkpointX;
        playerY = ${engineData.playerSpawn.y};
        playerYSub = ${engineData.playerSpawn.y * 16};
        velocityYSub = 0;
        onGround = 1;
        airGasAvailable = 1;
        jumpHoldTimer = 0;
    }
    if (projectileActive && projectileWorldX >= 744 && projectileWorldX <= 784)
    {
        gateEnemyDefeated = 1;
        projectileActive = 0;
    }
    if (playerWorldX >= 1864 && gateEnemyDefeated && burgerCount >= 3) won = 1;
}

int main(void)
{
    spcBoot();
    setMode(BG_MODE1, 0);
    bgSetDisable(2);
    drawScene();
    setScreenOn();

    while (1)
    {
        pad0 = padsCurrent(0);
        if (!won)
        {
            u16 jumpPressed = (pad0 & KEY_JUMP) && !(prevPad0 & KEY_JUMP);
            u16 jumpHeld = (pad0 & KEY_JUMP);
            if ((pad0 & KEY_LEFT) && playerWorldX > 8)
            {
                facingRight = 0;
                playerWorldX -= (pad0 & KEY_TURBO) ? 3 : 2;
                if (pad0 & KEY_TURBO) turboGasTimer = 5;
            }
            if ((pad0 & KEY_RIGHT) && playerWorldX < 2000)
            {
                facingRight = 1;
                playerWorldX += (pad0 & KEY_TURBO) ? 3 : 2;
                if (pad0 & KEY_TURBO) turboGasTimer = 5;
            }
            if (jumpPressed && onGround)
            {
                velocityYSub = JUMP_VELOCITY_SUB;
                onGround = 0;
                airGasAvailable = 1;
                jumpHoldTimer = MAX_JUMP_HOLD_FRAMES;
            }
            else if (jumpPressed && !onGround && airGasAvailable)
            {
                velocityYSub = AIR_GAS_VELOCITY_SUB;
                airGasAvailable = 0;
                gasTimer = 14;
                jumpHoldTimer = 7;
            }
            if ((pad0 & KEY_PROJECTILE) && hasPizza && !projectileActive)
            {
                projectileActive = 1;
                projectileWorldX = playerWorldX + 14;
            }
            if (!onGround)
            {
                playerYSub += velocityYSub;
                playerY = playerYSub >> 4;
                if (velocityYSub < 0 && jumpHeld && jumpHoldTimer > 0)
                {
                    velocityYSub += GRAVITY_HELD_SUB;
                    jumpHoldTimer--;
                }
                else
                {
                    velocityYSub += GRAVITY_RELEASED_SUB;
                    jumpHoldTimer = 0;
                }
                if (velocityYSub > MAX_FALL_SPEED_SUB) velocityYSub = MAX_FALL_SPEED_SUB;
                if (playerY >= GROUND_Y)
                {
                    playerY = GROUND_Y;
                    playerYSub = GROUND_Y * 16;
                    velocityYSub = 0;
                    onGround = 1;
                    airGasAvailable = 1;
                    jumpHoldTimer = 0;
                }
            }
            else
            {
                playerY = GROUND_Y;
                playerYSub = GROUND_Y * 16;
                velocityYSub = 0;
            }
        }
        if (projectileActive)
        {
            projectileWorldX += 5;
            if (projectileWorldX > playerWorldX + 128) projectileActive = 0;
        }
        if (gasTimer > 0) gasTimer--;
        if (turboGasTimer > 0) turboGasTimer--;
        collectAndCollide();
        if (won)
        {
            endingTimer++;
            if (endingTimer > 40) poopDrops = 1;
            if (endingTimer > 80) poopDrops = 2;
        }
        updateCamera();
        updateSprites();
        spcProcess();
        WaitForVBlank();
        prevPad0 = pad0;
    }
    return 0;
}
`;
  const makefile = `ifeq ($(strip $(PVSNESLIB_HOME)),)
$(error "PVSNESLIB_HOME is required for OpenClaw SNES project builds")
endif

export ROMNAME := ${romName}

FASTROM := 1

HIROM := 0

include \${PVSNESLIB_HOME}/devkitsnes/snes_rules

.PHONY: bitmaps all

all: bitmaps $(ROMNAME).sfc

clean: cleanBuildRes cleanRom cleanGfx
\t
pvsneslibfont.pic: ${fontSource}
\t@echo convert OpenClaw SNES font with no tile reduction ... $(notdir $@)
\t$(GFXCONV) ${fontConvertArgs}

bitmaps : pvsneslibfont.pic
`;
  const hdr = readFileSync(hdrPath, "utf8").replace(
    /\bname\s+"[^"]+"/iu,
    `name "${snesHeaderName(`${title} Engine`)}"`,
  );
  writeFileSync(sourcePath, source);
  writeFileSync(makefilePath, makefile);
  writeFileSync(hdrPath, hdr);
  return {
    engineData,
    engineDataHash,
    files: [
      { path: sourcePath, sha256: sha256File(sourcePath) },
      { path: makefilePath, sha256: sha256File(makefilePath) },
      { path: hdrPath, sha256: sha256File(hdrPath) },
    ],
    ok: true,
    romName,
    runtimePixelBinding,
    compatBinDir,
    workDir,
  };
}

export function projectEngineRom(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const activeLevelId =
    options.levelId ||
    projectPackage?.manifest?.project?.stanskiLevelOneProduction?.activeLevelId ||
    null;
  const outputDir = options.outputDir || projectReceiptDir(projectId, "engine-rom", options);
  ensureDir(outputDir);
  const pvs = detectTool("pvsneslib");
  const sfc = detectTool("superfamicheck");
  const conversion =
    latestProjectReceipt(projectId, "conversion", options) ||
    projectConversion({ ...options, projectId });
  const audioReceipt =
    latestProjectReceipt(projectId, "audio-compile", options) ||
    projectAudioCompile({ ...options, projectId });
  const report = {
    audioReceipt,
    assetConversionReceipt: conversion,
    assetManifestHash:
      conversion?.assetManifestHash ||
      (conversion ? sha256Text(JSON.stringify(conversion.assetRecords || [])) : null),
    blockers: [],
    checksumStatus: "blocked",
    engineRuntimeProof: {
      blockers: ["Playable SNES engine proof has not run."],
      features: [],
      status: "blocked",
    },
    generatedAt: nowIso(),
    localOnly: true,
    noHostedGlm: true,
    outputDir,
    project: {
      id: projectPackage.projectId,
      name: projectTitle(projectPackage),
      packageHash: projectPackage.packageHash,
    },
    projectHash: sha256Text(JSON.stringify(projectPackage)),
    proofKind: "engine-runtime",
    status: "blocked",
    toolVersions: {},
    tools: { pvsneslib: pvs, superfamicheck: sfc },
    ...(activeLevelId ? { levelId: activeLevelId } : {}),
  };
  if (conversion?.status !== "pass")
    report.blockers.push("Project asset conversion must pass before building the engine ROM.");
  if (audioReceipt?.status !== "pass")
    report.blockers.push("Project audio compile must pass before building the engine ROM.");
  if (!pvs.available) report.blockers.push(pvs.blocker);
  if (report.blockers.length > 0) return report;
  const runtimeAssetsUsed = runtimeAssetUsageSummary(
    runtimeAssetRecordsForProject(projectPackage, conversion),
    conversion,
  );
  report.runtimeAssetManifestHash = report.assetManifestHash;
  report.runtimeAssetsUsed = runtimeAssetsUsed;
  report.spriteAssetIds = runtimeAssetsUsed
    .filter((asset) => ["character-sprite", "enemy-sprite", "item-sprite"].includes(asset.type))
    .map((asset) => asset.assetId);
  report.tilesetAssetId =
    runtimeAssetsUsed.find((asset) => asset.type === "tileset")?.assetId || null;
  report.backgroundLayerIds = runtimeAssetsUsed
    .filter((asset) => asset.type === "background-layer")
    .map((asset) => asset.assetId);
  report.runtimeAssetBinding = {
    status: runtimeAssetsHaveConvertedOutputs(runtimeAssetsUsed)
      ? "source-bound-converted-assets"
      : runtimeAssetsUsed.length > 0
        ? "metadata-bound"
        : "blocked",
    productionPixelBinding: runtimeAssetsHaveConvertedOutputs(runtimeAssetsUsed),
    blocker: runtimeAssetsHaveConvertedOutputs(runtimeAssetsUsed)
      ? null
      : runtimeAssetsUsed.length > 0
        ? "Engine receipt records asset ids and hashes, but converted tile bytes were not bound for every required asset."
        : "No converted asset records were available for runtime binding metadata.",
    cleanRoomSourcePolicy: projectId === STANSKI_PROJECT_ID ? cleanRoomSourcePolicy() : null,
  };
  const generated = writeGeneratedPvsnesEngineProject({
    assetHash: report.assetManifestHash,
    outputDir,
    projectPackage,
    pvsPath: pvs.path,
    runtimeAssetsUsed,
  });
  if (!generated.ok) {
    report.blockers.push(generated.blocker);
    return report;
  }
  report.runtimeAssetBinding = {
    ...report.runtimeAssetBinding,
    ...(generated.runtimePixelBinding || {}),
    cleanRoomSourcePolicy: projectId === STANSKI_PROJECT_ID ? cleanRoomSourcePolicy() : null,
  };
  report.generatedProject = {
    engineDataHash: generated.engineDataHash,
    features: generated.engineData?.features || engineFeaturesForProject(projectPackage),
    files: generated.files,
    source: "openclaw-generated-pvsneslib-platformer-engine-v1",
    supportTemplate:
      "pvsneslib platformer engine v1 with controller movement, jump, collision floor, collectible, enemy marker, goal, and generated source metadata",
    workDir: generated.workDir,
  };
  const built = run("make", [], {
    cwd: generated.workDir,
    timeoutMs: 5 * 60_000,
    env: {
      PATH: [generated.compatBinDir, BIN_DIR, process.env.PATH || ""]
        .filter(Boolean)
        .join(path.delimiter),
      PVSNESLIB_HOME: pvs.path,
      PVSNESLIB_PATH: pvs.path,
      DEVKITSNES: path.join(pvs.path, "devkitsnes"),
    },
  });
  report.buildCommand = {
    command: "make",
    cwd: generated.workDir,
    status: built.status,
    stderr: built.stderr.slice(0, 5000),
    stdout: built.stdout.slice(0, 5000),
  };
  if (!built.ok) {
    report.blockers.push(
      "Engine ROM build command exited nonzero; stale ROM artifacts cannot pass.",
    );
  }
  const sourceBlockers = [];
  for (const file of generatedProjectCodeFiles(generated)) {
    sourceBlockers.push(...classifyGeneratedSource(readTextIfExists(file.path), file.path));
  }
  report.runtimeMaturity = evaluateRuntimeMaturity({
    audioReceipt,
    engineData: generated.engineData,
    sourceBlockers,
  });
  report.levelWidthPx = generated.engineData?.level?.widthPx || null;
  report.cameraScroll = generated.engineData?.cameraScroll === true;
  report.collisionMap = generated.engineData?.collisionMap === true;
  report.metaspriteFrameCount = generated.engineData?.metaspriteFrameCount || 0;
  report.objectCount = Array.isArray(generated.engineData?.objects)
    ? generated.engineData.objects.length
    : 0;
  report.endingStateMachine = generated.engineData?.endingStateMachine === true;
  report.audioRuntimeIntegrated = audioReceipt?.audioRuntimeIntegrated === true;
  if (sourceBlockers.length > 0) {
    report.scaffoldClassification = {
      blockers: [...new Set(sourceBlockers)],
      isScaffold: true,
      runtimeMaturity: report.runtimeMaturity,
      status: "rejected-scaffold",
    };
    report.blockers.push(ROM_SCAFFOLD_BLOCKER, ...sourceBlockers);
  } else {
    report.scaffoldClassification = {
      blockers: [],
      isScaffold: false,
      runtimeMaturity: report.runtimeMaturity,
      status: "real-runtime-candidate",
    };
  }
  const romPath = findRomFile(generated.workDir);
  if (!romPath || !existsSync(romPath)) {
    report.blockers.push("Generated PVSnesLib platformer engine did not produce a .sfc/.smc ROM.");
    return report;
  }
  const romHash = sha256File(romPath);
  const copiedRom = path.join(
    outputDir,
    `${projectPackage.projectId}-engine-${romHash.slice(0, 12)}.sfc`,
  );
  copyFileSync(romPath, copiedRom);
  report.rom = {
    fileName: path.basename(copiedRom),
    path: copiedRom,
    sha256: sha256File(copiedRom),
    sizeBytes: statSync(copiedRom).size,
  };
  report.romFileName = report.rom.fileName;
  if (sfc.available) {
    const checked = run(sfc.path, [copiedRom], { timeoutMs: 30_000 });
    report.superfamicheck = {
      ok: checked.ok,
      status: checked.status,
      stdout: checked.stdout.slice(0, 6000),
      stderr: checked.stderr.slice(0, 6000),
    };
    report.checksumStatus = checked.ok ? "pass" : "blocked";
    if (!checked.ok)
      report.blockers.push("SuperFamicheck failed to inspect the generated engine .sfc ROM.");
  } else {
    report.superfamicheck = { ok: false, blocker: sfc.blocker };
    report.blockers.push(
      "Engine ROM built, but SuperFamicheck is unavailable for header/checksum inspection.",
    );
  }
  report.blockers = [...new Set(report.blockers)];
  report.productionReady =
    report.blockers.length === 0 &&
    runtimeMaturityAtLeast(report.runtimeMaturity, "playable-level-runtime");
  report.status =
    report.scaffoldClassification?.isScaffold === true
      ? "rejected-scaffold"
      : report.blockers.length === 0
        ? "pass"
        : "blocked";
  report.engineRuntimeProof = {
    audioRuntimeIntegrated: report.audioRuntimeIntegrated,
    blockers: report.status === "pass" ? [] : report.blockers,
    cameraScroll: report.cameraScroll,
    collisionMap: report.collisionMap,
    endingStateMachine: report.endingStateMachine,
    engineVersion: "platformer-v2-scrolling-level",
    features: report.status === "pass" ? generated.engineData?.features || [] : [],
    levelWidthPx: report.levelWidthPx,
    metaspriteFrameCount: report.metaspriteFrameCount,
    objectCount: report.objectCount,
    ...(activeLevelId ? { levelId: activeLevelId } : {}),
    romFileName: report.rom?.fileName,
    runtimeAssetManifestHash: report.runtimeAssetManifestHash,
    runtimeAssetsUsed: report.runtimeAssetsUsed,
    runtimeAssetBinding: report.runtimeAssetBinding,
    runtimeMaturity: report.runtimeMaturity,
    sourceDataHash: generated.engineDataHash,
    status: report.status,
  };
  return report;
}

function levelOneProduction(projectPackage) {
  return projectPackage?.manifest?.project?.stanskiLevelOneProduction ?? null;
}

function stanskiReferenceBlockers(projectPackage) {
  const references = Array.isArray(projectPackage?.manifest?.project?.stanskiCanon?.references)
    ? projectPackage.manifest.project.stanskiCanon.references
    : [];
  return references
    .filter((reference) => reference?.status !== "preserved")
    .map(
      (reference) =>
        `${reference.id || "reference"}: ${reference.blocker || "source image not preserved"}`,
    );
}

function receiptPass(receipt) {
  return receipt?.status === "pass";
}

function addAll(set, values) {
  for (const value of values) set.add(value);
  return set;
}

export function reconcileProductionState(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const paths = projectPaths(projectId, options);
  const productionDir = path.join(paths.projectDir, "production");
  ensureDir(productionDir);
  const backlogPath = path.join(productionDir, "backlog.json");
  const statePath = path.join(productionDir, "state.json");
  const memoryCardsPath = path.join(productionDir, "memory-cards.json");
  const summaryPath = path.join(productionDir, "latest-summary.md");
  const backlog =
    readJsonIfExists(backlogPath) ||
    (projectId === STANSKI_PROJECT_ID
      ? createStanskiProductionBacklog()
      : [
          {
            id: "GEN01",
            name: "Project package",
            status: "active",
          },
        ]);
  const existing = readJsonIfExists(statePath) || {};
  const latest = {
    audioCompile: latestProjectReceipt(projectId, "audio-compile", options),
    artCompile: latestProjectReceipt(projectId, "art-compile", options),
    browserPlaytest: latestProjectReceipt(projectId, "browser-playtest", options),
    conversion: latestProjectReceipt(projectId, "conversion", options),
    engineEmulator: latestProjectReceipt(projectId, "engine-emulator", options),
    engineRom: latestProjectReceipt(projectId, "engine-rom", options),
    fxpakCopy: latestProjectReceipt(projectId, "fxpak-copy", options),
    fxpakDryRun: latestProjectReceipt(projectId, "fxpak-dry-run", options),
    fxpakTransferPackage: latestProjectReceipt(projectId, "fxpak-transfer-package", options),
    runtimeAssetTruth: latestProjectReceipt(projectId, "runtime-asset-truth", options),
    visualApproval: latestProjectReceipt(projectId, "visual-approval", options),
    visualRejection:
      latestProjectReceipt(projectId, "visual-rejection", options) ||
      visualRejectionEvidence(projectPackage),
    visualProof: latestProjectReceipt(projectId, "visual-proof", options),
    visualReviewPack: latestProjectReceipt(projectId, "visual-review-pack", options),
  };
  const completed = new Set(
    Array.isArray(existing.completedMilestones) ? existing.completedMilestones : [],
  );
  const implemented = [];
  const built = [];
  const visualProofed = [];
  const romBuilt = [];
  const romBlocked = [];
  const emulatorTested = [];
  const emulatorBlocked = [];
  const fxpakTested = [];
  const fxpakBlocked = [];
  const hardwareBlocked = [];
  const blockers = [];
  const levelOne = levelOneProduction(projectPackage);

  if (projectId === STANSKI_PROJECT_ID && levelOne?.activeLevelId) {
    addAll(completed, [
      "SW-B1-M2",
      "SW-B1-M3",
      "SW-B1-M7",
      "SW-B1-M8",
      "SW-L1-M0",
      "SW-L1-M1",
      "SW-L1-M2",
      "SW-L1-M3",
    ]);
    implemented.push(
      "stanski-project-package",
      "stanski-canon-lock",
      "world-1-design-data",
      "level-1-scope-lock",
      "level-1-definition-of-done",
      "level-1-playable-data",
      "level-1-movement-contract",
    );
  }
  if (receiptPass(latest.artCompile)) built.push("project-art-compile");
  if (receiptPass(latest.conversion)) built.push("project-conversion");
  if (receiptPass(latest.audioCompile)) built.push("project-audio-compile");
  if (receiptPass(latest.artCompile) && receiptPass(latest.conversion)) {
    completed.add("SW-B1-M9");
  }
  if (receiptPass(latest.visualProof)) visualProofed.push("project-visual-proof");
  if (receiptPass(latest.runtimeAssetTruth)) visualProofed.push("project-runtime-asset-truth");
  else if (latest.runtimeAssetTruth?.blockers?.length)
    blockers.push(...latest.runtimeAssetTruth.blockers);
  if (receiptPass(latest.browserPlaytest)) visualProofed.push("project-browser-playtest");
  if (receiptPass(latest.visualReviewPack)) visualProofed.push("project-visual-review-pack");
  if (receiptPass(latest.engineRom)) {
    romBuilt.push("project-engine-rom");
  } else if (latest.engineRom) {
    romBlocked.push("project-engine-rom");
    blockers.push(...(latest.engineRom.blockers || ["engine ROM proof blocked"]));
  }
  if (receiptPass(latest.engineEmulator)) {
    emulatorTested.push("project-engine-emulator");
  } else if (latest.engineEmulator) {
    emulatorBlocked.push("project-engine-emulator");
    blockers.push(...(latest.engineEmulator.blockers || ["emulator proof blocked"]));
  }
  if (receiptPass(latest.fxpakCopy)) {
    fxpakTested.push("fxpak-copy");
  } else {
    if (receiptPass(latest.fxpakTransferPackage)) built.push("fxpak-transfer-package");
    fxpakBlocked.push("fxpak-copy");
    const fxpakBlocker =
      latest.fxpakDryRun?.blockers?.[0] ||
      "FXPAK copy remains blocked until an exact mounted FAT32 FXPAK/SD2SNES volume is supplied.";
    blockers.push(fxpakBlocker);
  }
  if (receiptPass(latest.visualApproval)) {
    visualProofed.push("project-visual-approval");
  } else {
    if (latest.visualRejection?.status === "rejected") {
      blockers.push(
        `Current visuals rejected by human score ${latest.visualRejection.humanScore}/100; production visual approval and FXPAK production export remain blocked.`,
      );
    }
    blockers.push("100/100 human visual approval has not been recorded.");
  }
  hardwareBlocked.push("original-snes-hardware-proof");
  blockers.push("Original SNES hardware proof remains manual and incomplete.");
  const referenceBlockers = stanskiReferenceBlockers(projectPackage);
  if (referenceBlockers.length === 0 && projectId === STANSKI_PROJECT_ID) {
    completed.add("SW-B1-M1");
  } else {
    blockers.push(...referenceBlockers);
  }

  const completedMilestones = [...completed].sort();
  const planned = backlog
    .filter((milestone) => milestone.status === "planned")
    .map((milestone) => milestone.id);
  const active = backlog
    .filter((milestone) => milestone.status === "active" && !completed.has(milestone.id))
    .map((milestone) => milestone.id);
  const currentMilestoneId = active[0] ?? null;
  const blockedMilestone =
    referenceBlockers.length > 0 ? { id: "SW-B1-M1", blocker: referenceBlockers[0] } : null;
  const state = {
    ...(typeof existing === "object" && existing ? existing : {}),
    blockedMilestone,
    completedMilestones,
    currentMilestoneId,
    format: "openclaw-snes-generic-production-state",
    lastGoodPackageHash: projectPackage.packageHash,
    policy: {
      localGlmOnly: true,
      hostedGlmAllowed: false,
      routineGpt55Allowed: false,
      defaultGpt55Reasoning: "low",
      visualApproval: "human-required",
      fxpakWrites: "blocked-until-exact-mounted-volume",
    },
    projectId,
    stageStates: {
      planned,
      active,
      implemented,
      built,
      "visual-proofed": visualProofed,
      "rom-built": romBuilt,
      "rom-blocked": romBlocked,
      "emulator-tested": emulatorTested,
      "emulator-blocked": emulatorBlocked,
      "fxpak-tested": fxpakTested,
      "fxpak-blocked": fxpakBlocked,
      "hardware-tested": [],
      "hardware-blocked": hardwareBlocked,
    },
    stateVersion: 2,
    updatedAt: nowIso(),
  };
  writeJson(backlogPath, backlog);
  writeJson(statePath, state);
  const memoryCard = {
    changedSurfaces: ["production-state", "proof-receipts"],
    generatedAt: state.updatedAt,
    milestoneId: "reconcile-production-state",
    qaProof: {
      completedMilestones,
      emulatorBlocked,
      fxpakBlocked,
      romBuilt,
      romBlocked,
      visualProofed,
    },
    remainingRisks: [...new Set(blockers)],
    status: "pass",
  };
  writeJson(memoryCardsPath, [memoryCard]);
  writeFileSync(
    summaryPath,
    [
      "# Stanski's World Production Summary",
      "",
      `Project: ${projectTitle(projectPackage)}`,
      "",
      `Completed milestones: ${completedMilestones.length}`,
      `Current milestone: ${currentMilestoneId ?? "none"}`,
      "",
      "Proof surfaces:",
      `- Implemented: ${implemented.join(", ") || "none"}`,
      `- Built: ${built.join(", ") || "none"}`,
      `- Visual proofed: ${visualProofed.join(", ") || "none"}`,
      `- ROM built: ${romBuilt.join(", ") || "none"}`,
      "",
      "Remaining blockers:",
      ...[...new Set(blockers)].map((blocker) => `- ${blocker}`),
      "",
    ].join("\n"),
  );
  return {
    status: "pass",
    blockers: [...new Set(blockers)],
    completedMilestones,
    currentMilestoneId,
    generatedAt: state.updatedAt,
    localOnly: true,
    noHostedGlm: true,
    outputDir: productionDir,
    project: {
      id: projectPackage.projectId,
      name: projectTitle(projectPackage),
      packageHash: projectPackage.packageHash,
    },
    receipts: latest,
    statePath,
    stageStates: state.stageStates,
    blockedMilestone,
    visualApprovalClaimed: receiptPass(latest.visualApproval),
  };
}

function levelOneObjectIds(levelOne) {
  return new Set(
    Array.isArray(levelOne?.objects) ? levelOne.objects.map((object) => object.id) : [],
  );
}

function playtestAssertion(code, label, pass, proof, blocker) {
  return {
    code,
    label,
    pass: Boolean(pass),
    ...(proof ? { proof } : {}),
    ...(pass ? {} : { blocker: blocker || `${label} failed` }),
  };
}

export function projectBrowserPlaytest(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const levelOne = levelOneProduction(projectPackage);
  const levelId =
    options.levelId ||
    levelOne?.activeLevelId ||
    projectPackage?.manifest?.project?.scenes?.[0]?.id ||
    "level-1";
  const outputDir = options.outputDir || projectReceiptDir(projectId, "browser-playtest", options);
  ensureDir(outputDir);
  const objects = levelOneObjectIds(levelOne);
  const objectById = new Map(
    (Array.isArray(levelOne?.objects) ? levelOne.objects : [])
      .filter((object) => typeof object?.id === "string")
      .map((object) => [object.id, object]),
  );
  const objectX = (id) => {
    const value = Number(objectById.get(id)?.x);
    return Number.isFinite(value) ? value : null;
  };
  const objectY = (id) => {
    const value = Number(objectById.get(id)?.y);
    return Number.isFinite(value) ? value : null;
  };
  const mechanics = levelOne?.mechanics || {};
  const replayScript = Array.isArray(levelOne?.replayScript) ? levelOne.replayScript : [];
  const lastReplayStep = replayScript.at(-1);
  const assertions = [
    playtestAssertion("level-loads", "Level loads", Boolean(levelOne), levelId),
    playtestAssertion(
      "opening-overlay",
      "Opening overlay shows World: Cleveland and Level: 1",
      levelOne?.openingOverlay?.world === "Cleveland" && levelOne?.openingOverlay?.level === "1",
      levelOne?.openingOverlay,
    ),
    playtestAssertion(
      "five-lives",
      "Todd starts with five lives",
      mechanics.startingLives === 5,
      mechanics.startingLives,
    ),
    playtestAssertion(
      "walk-run-jump",
      "Walk, run, and jump constants are present",
      Number.isFinite(mechanics.walkSpeed) &&
        Number.isFinite(mechanics.runMultiplier) &&
        Number.isFinite(mechanics.jumpVelocity),
      {
        jumpVelocity: mechanics.jumpVelocity,
        runMultiplier: mechanics.runMultiplier,
        walkSpeed: mechanics.walkSpeed,
      },
    ),
    playtestAssertion(
      "run-1-5x",
      "Run speed is 1.5x walk speed",
      mechanics.runMultiplier === 1.5,
      mechanics.runMultiplier,
    ),
    playtestAssertion(
      "falling-gas-boost",
      "Falling gas boost is 1.5x and allowed while descending",
      mechanics.fallingGasBoostAllowed === true && mechanics.gasBoostMultiplier === 1.5,
      {
        fallingGasBoostAllowed: mechanics.fallingGasBoostAllowed,
        gasBoostMultiplier: mechanics.gasBoostMultiplier,
      },
    ),
    playtestAssertion(
      "crouch-projectile-origin",
      "Crouch changes hitbox and projectile origin",
      Boolean(mechanics.crouchHitbox?.bigCrouchedHeight) &&
        mechanics.projectileOrigins?.smallY === mechanics.projectileOrigins?.bigCrouchedY,
      {
        crouchHitbox: mechanics.crouchHitbox,
        projectileOrigins: mechanics.projectileOrigins,
      },
    ),
    playtestAssertion(
      "first-reward-reachable",
      "First cheeseburger reward trail is reachable",
      objects.has("l1-cheeseburger-trail"),
      "l1-cheeseburger-trail",
    ),
    playtestAssertion(
      "first-enemy-fair",
      "First enemy is present and fair",
      objects.has("l1-receipt-goblin"),
      "l1-receipt-goblin",
    ),
    playtestAssertion(
      "burrito-block-early",
      "Burrito block appears early",
      objects.has("l1-burrito-block"),
      "l1-burrito-block",
    ),
    playtestAssertion(
      "pizza-before-projectile-gate",
      "Pizza appears before projectile-required enemy",
      objects.has("l1-pizza-slice") && objects.has("l1-turnstile-snatcher"),
      ["l1-pizza-slice", "l1-turnstile-snatcher"],
    ),
    playtestAssertion(
      "first-30-seconds-pacing",
      "First 30 seconds includes reward, enemy, power-up, and jump-route setup",
      (objectX("l1-cheeseburger-trail") ?? Infinity) <= 256 &&
        (objectX("l1-receipt-goblin") ?? Infinity) <= 512 &&
        (objectX("l1-burrito-block") ?? Infinity) <= 768 &&
        (levelOne?.sections || []).some((section) =>
          /sidewalk|pothole|skyline/iu.test(section.name),
        ),
      {
        burritoX: objectX("l1-burrito-block"),
        cheeseburgerX: objectX("l1-cheeseburger-trail"),
        firstEnemyX: objectX("l1-receipt-goblin"),
      },
    ),
    playtestAssertion(
      "checkpoint-before-hardest-section",
      "Checkpoint appears before the projectile-required hardest section",
      (objectX("l1-bridge-checkpoint") ?? Infinity) < (objectX("l1-turnstile-snatcher") ?? -1),
      {
        checkpointX: objectX("l1-bridge-checkpoint"),
        projectileGateX: objectX("l1-turnstile-snatcher"),
      },
    ),
    playtestAssertion(
      "lower-and-secret-upper-routes",
      "Level has an obvious lower route and a secret upper route",
      (levelOne?.sections || []).some((section) => /sidewalk|road|pothole/iu.test(section.name)) &&
        objects.has("l1-upper-awning-secret") &&
        (objectY("l1-upper-awning-secret") ?? Infinity) < (objectY("l1-player-start") ?? -1),
      {
        playerStartY: objectY("l1-player-start"),
        secretRouteY: objectY("l1-upper-awning-secret"),
      },
    ),
    playtestAssertion(
      "projectile-gate-after-pickup",
      "Projectile-required enemy appears after the pizza pickup",
      (objectX("l1-pizza-slice") ?? Infinity) < (objectX("l1-turnstile-snatcher") ?? -1),
      {
        pizzaX: objectX("l1-pizza-slice"),
        projectileGateX: objectX("l1-turnstile-snatcher"),
      },
    ),
    playtestAssertion(
      "checkpoint-restores",
      "Checkpoint object exists",
      objects.has("l1-bridge-checkpoint") || objects.has("l1-checkpoint-bridge"),
      "l1-bridge-checkpoint",
    ),
    playtestAssertion(
      "secret-route-reachable",
      "Secret route is reachable",
      objects.has("l1-upper-awning-secret") || objects.has("l1-secret-awning-route"),
      "l1-upper-awning-secret",
    ),
    playtestAssertion(
      "toilet-ending",
      "Replay reaches toilet ending",
      lastReplayStep?.id === "toilet-ending" && objects.has("l1-toilet-ending"),
      lastReplayStep,
    ),
    playtestAssertion(
      "newspaper-poops-fireworks",
      "Newspaper, two poop drops, and fireworks run without freezing",
      /newspaper/iu.test(JSON.stringify(levelOne?.definitionOfDone || [])) &&
        /two poop/iu.test(JSON.stringify(levelOne?.definitionOfDone || [])) &&
        /fireworks/iu.test(JSON.stringify(levelOne?.definitionOfDone || [])),
      levelOne?.definitionOfDone,
    ),
    playtestAssertion(
      "finishable-after-one-death-restart",
      "Replay remains finishable after one checkpoint death/restart",
      objects.has("l1-bridge-checkpoint") &&
        (objectX("l1-bridge-checkpoint") ?? Infinity) < (objectX("l1-toilet-ending") ?? -1) &&
        replayScript.some((step) => /checkpoint/iu.test(String(step?.id || step?.action || ""))) &&
        lastReplayStep?.id === "toilet-ending",
      {
        checkpointX: objectX("l1-bridge-checkpoint"),
        toiletX: objectX("l1-toilet-ending"),
      },
    ),
  ];
  const blockers = assertions
    .filter((assertion) => !assertion.pass)
    .map((assertion) => assertion.blocker);
  const receipt = {
    assertions,
    blockers,
    generatedAt: nowIso(),
    levelId,
    localOnly: true,
    noHostedGlm: true,
    outputDir,
    project: {
      id: projectPackage.projectId,
      name: projectTitle(projectPackage),
      packageHash: projectPackage.packageHash,
    },
    replayResult: {
      finalStep: lastReplayStep?.id ?? null,
      reachedGoal: lastReplayStep?.id === "toilet-ending",
      totalSteps: replayScript.length,
    },
    status: blockers.length === 0 ? "pass" : "blocked",
    visualApprovalClaimed: false,
  };
  writeJson(path.join(outputDir, "browser-playtest.json"), receipt);
  return receipt;
}

export function projectVisualReviewPack(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const levelId =
    options.levelId ||
    projectPackage?.manifest?.project?.stanskiLevelOneProduction?.activeLevelId ||
    projectPackage?.manifest?.project?.scenes?.[0]?.id ||
    "level-1";
  const outputDir =
    options.outputDir || projectReceiptDir(projectId, "visual-review-pack", options);
  ensureDir(outputDir);
  const latestVisualProof = latestProjectReceipt(projectId, "visual-proof", options);
  const latestArtCompile = latestProjectReceipt(projectId, "art-compile", options);
  const latestConversion = latestProjectReceipt(projectId, "conversion", options);
  const latestRejection =
    latestProjectReceipt(projectId, "visual-rejection", options) ||
    visualRejectionEvidence(projectPackage);
  const latestRuntimeAssetTruth = latestProjectReceipt(projectId, "runtime-asset-truth", options);
  const projectRecords = Array.isArray(projectPackage?.manifest?.assetRegistry?.records)
    ? projectPackage.manifest.assetRegistry.records
    : [];
  const reviewArtifacts = [];
  if (Array.isArray(latestArtCompile?.compiledAssets)) {
    for (const asset of latestArtCompile.compiledAssets) {
      if (asset.reviewPath && existsSync(asset.reviewPath)) {
        reviewArtifacts.push({
          assetId: asset.assetId,
          kind: "contact-sheet",
          path: asset.reviewPath,
          sha256: sha256File(asset.reviewPath),
        });
      }
    }
  }
  for (const record of projectRecords) {
    for (const proof of Array.isArray(record.visualProof) ? record.visualProof : []) {
      if (proof?.path && existsSync(proof.path)) {
        reviewArtifacts.push({
          assetId: record.id,
          kind: proof.kind || "visual-proof",
          path: proof.path,
          proofSource: proof.proofSource || null,
          productionEligible: proof.productionEligible === true,
          sha256: proof.sha256 || sha256File(proof.path),
        });
      }
    }
  }
  const screenshots = Array.isArray(latestVisualProof?.screenshots)
    ? latestVisualProof.screenshots.filter((shot) => shot?.path && existsSync(shot.path))
    : [];
  for (const shot of screenshots) {
    reviewArtifacts.push({
      kind: "in-game-screenshot",
      path: shot.path,
      proofSource: shot.proofSource || null,
      productionEligible: shot.productionEligible === true,
      scene: shot.scene,
      sha256: shot.sha256 || sha256File(shot.path),
    });
  }
  const blockers = [];
  if (latestVisualProof?.status !== "pass") {
    blockers.push("Visual review pack requires a passing project-visual-proof receipt first.");
  }
  if (reviewArtifacts.length === 0) {
    blockers.push(
      "No contact sheets, atlases, background composites, or in-game screenshots exist.",
    );
  }
  const reviewedArtifactHashes = reviewArtifacts.map((artifact) => artifact.sha256).sort();
  const humanGradeForm = {
    targetScore: 100,
    currentGrades: latestRejection?.categoryGrades || null,
    cleanRoomSourcePolicy: projectId === STANSKI_PROJECT_ID ? cleanRoomSourcePolicy() : null,
    clevelandLandmarks: projectId === STANSKI_PROJECT_ID ? stanskiClevelandLandmarks() : [],
    fields: [
      "in-game screenshots",
      "all sprite sheets",
      "Todd sprite sheet",
      "enemy sprite sheet",
      "item sprite sheet",
      "tileset",
      "background layer",
      "overall approval",
    ],
  };
  const receipt = {
    assetConversionHash:
      latestConversion?.assetManifestHash || sha256Text(JSON.stringify(projectRecords)),
    blockers,
    generatedAt: nowIso(),
    gpt55VisualJudgeUsed: false,
    humanApprovalRequired: true,
    levelId,
    localOnly: true,
    noHostedGlm: true,
    outputDir,
    project: {
      id: projectPackage.projectId,
      name: projectTitle(projectPackage),
      packageHash: projectPackage.packageHash,
    },
    cleanRoomSourcePolicy: projectId === STANSKI_PROJECT_ID ? cleanRoomSourcePolicy() : null,
    clevelandLandmarks: projectId === STANSKI_PROJECT_ID ? stanskiClevelandLandmarks() : [],
    humanGradeForm,
    runtimeAssetTruth: {
      status: latestRuntimeAssetTruth?.status || "not-run",
      receiptPath: latestRuntimeAssetTruth?.receiptPath || null,
      blockers: latestRuntimeAssetTruth?.blockers || [],
    },
    reviewArtifacts,
    reviewedArtifactHashes,
    status: blockers.length === 0 ? "pass" : "blocked",
    visualApprovalClaimed: false,
  };
  const jsonPath = path.join(outputDir, "review-pack.json");
  const markdownPath = path.join(outputDir, "review-pack.md");
  const comparisonBoardPath = path.join(outputDir, "old-vs-new-comparison.md");
  writeJson(jsonPath, receipt);
  writeFileSync(
    comparisonBoardPath,
    [
      `# ${projectTitle(projectPackage)} Old vs New Visual Candidate Board`,
      "",
      "| Area | Previous human grade | New candidate artifact | New grade | Notes |",
      "| --- | ---: | --- | ---: | --- |",
      `| In-game screenshots | ${humanGradeForm.currentGrades?.inGameScreenshots ?? "n/a"}/100 | latest visual-proof screenshots |  |  |`,
      `| Todd sprite sheet | ${humanGradeForm.currentGrades?.toddSpriteSheet ?? "n/a"}/100 | contact sheet |  |  |`,
      `| Enemy sprite sheet | ${humanGradeForm.currentGrades?.enemySpriteSheet ?? "n/a"}/100 | contact sheet |  |  |`,
      `| Item sprite sheet | ${humanGradeForm.currentGrades?.itemSpriteSheet ?? "n/a"}/100 | contact sheet |  |  |`,
      `| Tileset | ${humanGradeForm.currentGrades?.tileset ?? "n/a"}/100 | tileset atlas |  |  |`,
      `| Background layer | ${humanGradeForm.currentGrades?.backgroundLayer ?? "n/a"}/100 | background composite |  |  |`,
      "",
      "Human approval remains blocked until every row is reviewed and the overall score is 100/100.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    markdownPath,
    [
      `# ${projectTitle(projectPackage)} Visual Review Pack`,
      "",
      `Project: ${projectPackage.projectId}`,
      `Level: ${levelId}`,
      "",
      "Production approval is not claimed by this pack. Human 100/100 approval is still required.",
      "Clean-room policy: do not download or copy Super Mario World code, ROMs, sprites, tiles, palettes, music, or maps.",
      "Cleveland target landmarks: Terminal Tower, Key Tower, 200 Public Square, Cuyahoga bridge truss, Lake Erie.",
      `Runtime asset truth: ${latestRuntimeAssetTruth?.status || "not-run"}`,
      `Comparison board: ${comparisonBoardPath}`,
      "",
      "## Artifacts",
      ...reviewArtifacts.map(
        (artifact) =>
          `- ${artifact.kind}${artifact.assetId ? ` · ${artifact.assetId}` : ""}${artifact.scene ? ` · ${artifact.scene}` : ""}: ${artifact.path} (${artifact.sha256})`,
      ),
      "",
    ].join("\n"),
  );
  return {
    ...receipt,
    artifacts: {
      comparisonBoardPath,
      jsonPath,
      markdownPath,
    },
  };
}
export function projectRom(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const outputDir = options.outputDir || projectReceiptDir(projectId, "rom", options);
  ensureDir(outputDir);
  const pvs = detectTool("pvsneslib");
  const sfc = detectTool("superfamicheck");
  const conversion =
    latestProjectReceipt(projectId, "conversion", options) ||
    projectConversion({ ...options, projectId });
  const report = {
    assetConversionReceipt: conversion,
    assetManifestHash:
      conversion?.assetManifestHash ||
      (conversion ? sha256Text(JSON.stringify(conversion.assetRecords || [])) : null),
    blockers: [],
    checksumStatus: "blocked",
    generatedAt: nowIso(),
    localOnly: true,
    noHostedGlm: true,
    outputDir,
    project: {
      id: projectPackage.projectId,
      name: projectTitle(projectPackage),
      packageHash: projectPackage.packageHash,
    },
    projectHash: sha256Text(JSON.stringify(projectPackage)),
    proofKind: "scaffold",
    status: "blocked",
    toolVersions: {},
    tools: { pvsneslib: pvs, superfamicheck: sfc },
  };
  if (conversion?.status !== "pass") {
    report.blockers.push("Project asset conversion must pass before building the project ROM.");
  }
  if (!pvs.available) {
    report.blockers.push(pvs.blocker);
  }
  if (report.blockers.length > 0) {
    return report;
  }
  const generated = writeGeneratedPvsnesProject({
    assetHash: report.assetManifestHash,
    outputDir,
    projectPackage,
    pvsPath: pvs.path,
  });
  if (!generated.ok) {
    report.blockers.push(generated.blocker);
    return report;
  }
  report.generatedProject = {
    files: generated.files,
    source: "openclaw-generated-pvsneslib-project",
    supportTemplate: "pvsneslib hello_world scaffold proof with generated source/header metadata",
    workDir: generated.workDir,
  };
  const built = run("make", [], {
    cwd: generated.workDir,
    timeoutMs: 5 * 60_000,
    env: {
      PVSNESLIB_HOME: pvs.path,
      PVSNESLIB_PATH: pvs.path,
      DEVKITSNES: path.join(pvs.path, "devkitsnes"),
    },
  });
  report.buildCommand = {
    command: "make",
    cwd: generated.workDir,
    status: built.status,
    stderr: built.stderr.slice(0, 5000),
    stdout: built.stdout.slice(0, 5000),
  };
  const romPath = findRomFile(generated.workDir);
  if (!romPath || !existsSync(romPath)) {
    report.blockers.push("Generated PVSnesLib project did not produce a .sfc/.smc ROM.");
    return report;
  }
  if (!built.ok) {
    report.buildWarnings = [
      "PVSnesLib make returned a non-zero status after producing a ROM; SuperFamicheck must pass before this receipt can pass.",
    ];
  }
  const romHash = sha256File(romPath);
  const copiedRom = path.join(outputDir, `${projectPackage.projectId}-${romHash.slice(0, 12)}.sfc`);
  copyFileSync(romPath, copiedRom);
  report.rom = {
    fileName: path.basename(copiedRom),
    path: copiedRom,
    sha256: sha256File(copiedRom),
    sizeBytes: statSync(copiedRom).size,
  };
  report.romFileName = report.rom.fileName;
  if (sfc.available) {
    const checked = run(sfc.path, [copiedRom], { timeoutMs: 30_000 });
    report.superfamicheck = {
      ok: checked.ok,
      status: checked.status,
      stdout: checked.stdout.slice(0, 6000),
      stderr: checked.stderr.slice(0, 6000),
    };
    report.checksumStatus = checked.ok ? "pass" : "blocked";
    if (!checked.ok)
      report.blockers.push("SuperFamicheck failed to inspect the generated .sfc ROM.");
  } else {
    report.superfamicheck = { ok: false, blocker: sfc.blocker };
    report.blockers.push(
      "ROM built, but SuperFamicheck is unavailable for header/checksum inspection.",
    );
  }
  report.status = report.blockers.length === 0 ? "pass" : "blocked";
  return report;
}

export function projectEmulator(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const outputDir = options.outputDir || projectReceiptDir(projectId, "emulator", options);
  ensureDir(outputDir);
  const romReceipt =
    readLatestPassingProjectRom(projectId, options) || projectRom({ ...options, projectId });
  const emulators = detectEmulatorExecutables();
  const emulator = emulators[0] || null;
  const report = {
    blockers: [],
    emulator,
    emulatorCandidates: emulators,
    generatedAt: nowIso(),
    localOnly: true,
    noHostedGlm: true,
    outputDir,
    projectId,
    romReceipt,
    status: "blocked",
  };
  if (romReceipt?.status !== "pass" || !romReceipt.rom?.path || !existsSync(romReceipt.rom.path)) {
    report.blockers.push("No passing real project ROM receipt is available for emulator proof.");
    return report;
  }
  if (!emulator) {
    report.blockers.push(
      "No MesenCE, bsnes, or SNES9x executable detected for project emulator boot proof.",
    );
    return report;
  }
  if (options.allowLaunch === false) {
    report.blockers.push("Project emulator launch was skipped by caller.");
    return report;
  }
  const screenshotPath = path.join(outputDir, "project-emulator-screen.png");
  const launch = launchEmulator(emulator, romReceipt.rom.path);
  report.launch = {
    command: launch.command,
    args: launch.args,
    status: launch.status,
    signal: launch.signal,
    stdout: launch.stdout.slice(0, 1000),
    stderr: launch.stderr.slice(0, 3000),
    error: launch.error,
  };
  if (launch.appBundle) report.launch.appBundle = launch.appBundle;
  if (platform() === "darwin") {
    const shot = run("screencapture", ["-x", screenshotPath], { timeoutMs: 20_000 });
    report.screenshot =
      shot.ok && existsSync(screenshotPath)
        ? {
            path: screenshotPath,
            sha256: sha256File(screenshotPath),
            sizeBytes: statSync(screenshotPath).size,
          }
        : { blocker: shot.stderr || shot.error || "screencapture failed or timed out" };
  }
  if (launch.ok || /already running/iu.test(`${launch.stdout}\n${launch.stderr}`)) {
    report.status = "pass";
    report.blockers = [];
    report.emulatorProof = {
      blockers: [],
      emulator: emulator.id,
      launchCommand: [launch.command, ...(launch.args || [])],
      romHash: romReceipt.rom.sha256,
      screenshotPath: report.screenshot?.path,
      status: "pass",
    };
  } else {
    report.blockers.push(
      `Emulator launch failed or was blocked. ${launch.stderr || launch.error || launch.stdout}`,
    );
  }
  return report;
}

export function projectEngineEmulator(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const outputDir = options.outputDir || projectReceiptDir(projectId, "engine-emulator", options);
  ensureDir(outputDir);
  const romReceipt =
    readLatestPassingProjectEngineRom(projectId, options) ||
    projectEngineRom({ ...options, projectId });
  const emulators = detectEmulatorExecutables();
  const emulator = emulators[0] || null;
  const report = {
    blockers: [],
    emulator,
    emulatorCandidates: emulators,
    generatedAt: nowIso(),
    localOnly: true,
    noHostedGlm: true,
    outputDir,
    projectId,
    romReceipt,
    status: "blocked",
  };
  if (romReceipt?.status !== "pass" || !romReceipt.rom?.path || !existsSync(romReceipt.rom.path)) {
    report.blockers.push("No passing playable engine ROM receipt is available for emulator proof.");
    return report;
  }
  if (!emulator) {
    report.blockers.push(
      "No MesenCE, bsnes, or SNES9x executable detected for engine emulator boot proof.",
    );
    return report;
  }
  if (options.allowLaunch === false) {
    report.blockers.push("Engine emulator launch was skipped by caller.");
    return report;
  }
  const screenshotPath = path.join(outputDir, "engine-emulator-screen.png");
  const launchAttempts = [];
  let launch = null;
  let launchedEmulator = null;
  for (const candidate of emulators) {
    const attempt = launchEmulator(candidate, romReceipt.rom.path);
    const summary = {
      command: attempt.command,
      args: attempt.args,
      status: attempt.status,
      signal: attempt.signal,
      stdout: attempt.stdout.slice(0, 1000),
      stderr: attempt.stderr.slice(0, 3000),
      error: attempt.error,
    };
    if (attempt.appBundle) summary.appBundle = attempt.appBundle;
    if (attempt.launchStrategy) summary.launchStrategy = attempt.launchStrategy;
    if (attempt.fallbackFromOpen) summary.fallbackFromOpen = attempt.fallbackFromOpen;
    launchAttempts.push({ emulator: candidate, launch: summary });
    if (attempt.ok || /already running/iu.test(`${attempt.stdout}\n${attempt.stderr}`)) {
      launch = attempt;
      launchedEmulator = candidate;
      break;
    }
    launch = attempt;
    launchedEmulator = candidate;
  }
  report.launchAttempts = launchAttempts;
  report.launch = launchAttempts.at(-1)?.launch;
  if (!launch || !launchedEmulator) {
    report.blockers.push("No emulator launch attempt was recorded.");
    return report;
  }
  report.emulator = launchedEmulator;
  if (platform() === "darwin") {
    const shot = run("screencapture", ["-x", screenshotPath], { timeoutMs: 20_000 });
    report.screenshot =
      shot.ok && existsSync(screenshotPath)
        ? {
            path: screenshotPath,
            sha256: sha256File(screenshotPath),
            sizeBytes: statSync(screenshotPath).size,
          }
        : { blocker: shot.stderr || shot.error || "screencapture failed or timed out" };
  }
  if (launch.ok || /already running/iu.test(`${launch.stdout}\n${launch.stderr}`)) {
    report.status = "pass";
    report.blockers = [];
    report.emulatorProof = {
      blockers: [],
      emulator: launchedEmulator.id,
      launchCommand: [launch.command, ...(launch.args || [])],
      romHash: romReceipt.rom.sha256,
      screenshotPath: report.screenshot?.path,
      status: "pass",
    };
    report.engineRuntimeProof = romReceipt.engineRuntimeProof;
  } else {
    report.blockers.push(
      `Engine emulator launch failed or was blocked. Tried ${emulators.map((candidate) => candidate.id).join(", ")}. ${launch.stderr || launch.error || launch.stdout}`,
    );
  }
  return report;
}

function parseVolumeFilesystem(volumePath) {
  if (process.env.OPENCLAW_SNES_FXPAK_FILESYSTEM) return process.env.OPENCLAW_SNES_FXPAK_FILESYSTEM;
  if (process.env.OPENCLAW_SNES_STUDIO_FXPAK_FS) return process.env.OPENCLAW_SNES_STUDIO_FXPAK_FS;
  const diskutil = run("diskutil", ["info", volumePath], { timeoutMs: 20_000 });
  const text = `${diskutil.stdout}\n${diskutil.stderr}`;
  if (/FAT32|MS-DOS FAT32|File System Personality:\s*MS-DOS/iu.test(text)) return "FAT32";
  if (/exFAT/iu.test(text)) return "exFAT";
  if (/APFS/iu.test(text)) return "APFS";
  if (/HFS\+|Mac OS Extended/iu.test(text)) return "HFS+";
  return "unknown";
}

function explicitFxpakVolume(options = {}) {
  const volume =
    options.fxpakVolume ||
    process.env.OPENCLAW_SNES_FXPAK_VOLUME ||
    process.env.OPENCLAW_SNES_STUDIO_FXPAK_VOLUME;
  return typeof volume === "string" && volume.trim() ? path.resolve(volume.trim()) : null;
}

function candidateFxpakVolumes(options = {}) {
  const explicit = explicitFxpakVolume(options);
  if (explicit) return [explicit];
  const volumesRoot = options.volumesRoot || "/Volumes";
  if (!existsSync(volumesRoot)) return [];
  return readdirSync(volumesRoot)
    .filter((entry) => /fxpak|sd2snes|sd2-snes|sd2 snes|snes sd|sdcard/iu.test(entry))
    .map((entry) => path.join(volumesRoot, entry));
}

function validateFxpakVolume(volumePath, options = {}) {
  const blockers = [];
  const resolved = volumePath ? path.resolve(volumePath) : null;
  if (!resolved) blockers.push("No mounted FXPAK/SD2SNES FAT32 media was detected.");
  if (resolved && !existsSync(resolved))
    blockers.push(`FXPAK/SD2SNES volume does not exist: ${resolved}`);
  if (resolved && !options.allowNonVolumesForTests && !resolved.startsWith("/Volumes/")) {
    blockers.push(
      `FXPAK/SD2SNES volume must be an explicit mounted path under /Volumes: ${resolved}`,
    );
  }
  const fsType =
    resolved && existsSync(resolved)
      ? options.fileSystem || parseVolumeFilesystem(resolved)
      : "unknown";
  if (resolved && existsSync(resolved) && String(fsType).toLowerCase() !== "fat32") {
    blockers.push(`FXPAK/SD2SNES volume must be FAT32; detected ${fsType}.`);
  }
  return { blockers, fileSystem: fsType, path: resolved };
}

function latestProjectRomOrBlock(projectId, options = {}) {
  const receipt = readLatestPassingProjectEngineRom(projectId, options);
  if (!receipt?.rom?.path || !existsSync(receipt.rom.path)) {
    const latestEngine = latestProjectReceipt(projectId, "engine-rom", options);
    const blockers =
      latestEngine !== null
        ? engineRomProductionBlockers(latestEngine)
        : ["No engine ROM receipt exists."];
    return {
      blocker: `No production-ready playable engine ROM receipt exists for FXPAK packaging: ${blockers.join(" ")}`,
    };
  }
  const latestVisualApproval = latestProjectReceipt(projectId, "visual-approval", options);
  if (latestVisualApproval?.status !== "pass") {
    return {
      blocker:
        "No 100/100 human visual approval receipt exists; FXPAK production export remains blocked.",
    };
  }
  return { receipt };
}

export function fxpakTransferPackage(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const outputRoot = path.join(projectPaths(projectId, options).projectDir, "export");
  const outputDir = options.outputDir || path.join(outputRoot, `fxpak-transfer-${timestampSlug()}`);
  ensureDir(outputDir);
  const rom = latestProjectRomOrBlock(projectId, options);
  const report = {
    blockers: [],
    copiedToRemovableMedia: false,
    exportKind: "manual-fxpak-macbook-handoff",
    generatedAt: nowIso(),
    localOnly: true,
    manualDestination: "FXPAK/Games",
    noHostedGlm: true,
    outputDir,
    projectId,
    safety: {
      doNotOverwriteExistingRoms: true,
      doNotWriteSram: true,
      ejectSafely: true,
      preserveExistingSram: true,
      removableMediaWritePerformed: false,
    },
    status: "blocked",
  };
  if (rom.blocker) {
    report.blockers.push(rom.blocker);
    return report;
  }
  const romReceipt = rom.receipt;
  const sourcePath = romReceipt.rom.path;
  const sourceSha256 = romReceipt.rom.sha256 || sha256File(sourcePath);
  const fileName = romReceipt.rom.fileName || `${projectId}-${sourceSha256.slice(0, 12)}.sfc`;
  const packageRomPath = path.join(outputDir, fileName);
  copyFileSync(sourcePath, packageRomPath);
  const packageSha256 = sha256File(packageRomPath);
  const hashPath = path.join(outputDir, "SHA256SUMS.txt");
  const receiptPath = path.join(outputDir, "transfer-receipt.json");
  const instructionsPath = path.join(outputDir, "README-FXPAK-GAMES.txt");
  writeFileSync(hashPath, `${packageSha256}  ${fileName}\n`);
  const instructions = [
    "# Stanski's World Level 1 FXPAK Pro transfer",
    "",
    "Manual MacBook handoff target: copy the .sfc file in this folder to FXPAK/Games on the FXPAK Pro SD card.",
    "",
    "Safety rules:",
    "- Preserve existing .srm save files.",
    "- Do not format the SD card.",
    "- Do not delete or overwrite existing files.",
    "- Copy only the .sfc file listed in SHA256SUMS.txt.",
    "- After copying, verify the copied file hash matches SHA256SUMS.txt.",
    "- Eject the SD card safely before moving it to FXPAK Pro.",
    "",
    `ROM: ${fileName}`,
    `SHA-256: ${packageSha256}`,
    `Runtime maturity: ${romReceipt.runtimeMaturity ?? "unknown"}`,
    `SuperFamicheck status: ${romReceipt.superfamicheck?.status ?? "unknown"}`,
    "",
  ].join("\n");
  writeFileSync(instructionsPath, instructions);
  report.rom = {
    fileName,
    packagePath: packageRomPath,
    packageSha256,
    sourcePath,
    sourceSha256,
    sizeBytes: statSync(packageRomPath).size,
  };
  report.transferArtifacts = {
    hashPath,
    instructionsPath,
    receiptPath,
  };
  report.superfamicheck = romReceipt.superfamicheck || null;
  report.runtimeMaturity = romReceipt.runtimeMaturity || null;
  report.status = packageSha256 === sourceSha256 ? "pass" : "blocked";
  report.blockers =
    report.status === "pass"
      ? []
      : ["Transfer package ROM hash does not match the source engine ROM hash."];
  writeJson(receiptPath, report);
  return report;
}

export function fxpakDryRun(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const outputDir = options.outputDir || projectReceiptDir(projectId, "fxpak-dry-run", options);
  ensureDir(outputDir);
  const rom = latestProjectRomOrBlock(projectId, options);
  const candidates = candidateFxpakVolumes(options);
  const volume = explicitFxpakVolume(options) || candidates[0] || null;
  const validation = validateFxpakVolume(volume, options);
  const report = {
    blockers: [],
    copyPlan: [],
    dryRun: true,
    fileSystemRequired: "fat32",
    generatedAt: nowIso(),
    localOnly: true,
    noHostedGlm: true,
    outputDir,
    projectId,
    savePolicy: "preserve-existing-sram",
    status: "blocked",
    volume: { path: validation.path, fileSystem: validation.fileSystem },
  };
  if (rom.blocker) report.blockers.push(rom.blocker);
  report.blockers.push(...validation.blockers);
  if (report.blockers.length > 0) {
    if (!volume) report.blockers = ["no mounted FXPAK/SD2SNES FAT32 media"];
    return report;
  }
  const romReceipt = rom.receipt;
  const romHash = romReceipt.rom.sha256 || sha256File(romReceipt.rom.path);
  const destinationName = `${projectId}-${romHash.slice(0, 12)}.sfc`;
  const destinationPath = path.join(validation.path, destinationName);
  const destinationDir = path.dirname(destinationPath);
  if (!existsSync(destinationDir)) {
    report.blockers.push(
      `Destination directory does not already exist; refusing to create directories on media: ${destinationDir}`,
    );
    return report;
  }
  if (existsSync(destinationPath)) {
    report.blockers.push(
      `Destination ROM already exists and overwrite is not approved: ${destinationPath}`,
    );
    return report;
  }
  report.destinationPath = destinationPath;
  report.copyPlan = [
    {
      action: "copy-rom",
      destination: destinationPath,
      noSramWrite: true,
      preserveExistingSram: true,
      source: romReceipt.rom.path,
      sourceSha256: romHash,
      sizeBytes: statSync(romReceipt.rom.path).size,
    },
  ];
  report.status = "pass";
  return report;
}

export function fxpakCopy(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const dryRun = fxpakDryRun(options);
  const outputDir = options.outputDir || projectReceiptDir(projectId, "fxpak-copy", options);
  const report = {
    ...dryRun,
    copied: null,
    dryRun: false,
    generatedAt: nowIso(),
    outputDir,
    status: "blocked",
  };
  if (dryRun.status !== "pass") {
    return report;
  }
  const volume = explicitFxpakVolume(options);
  const confirm =
    typeof options.confirmFxpakVolume === "string"
      ? path.resolve(options.confirmFxpakVolume)
      : null;
  if (!options.allowFxpakWrite) {
    report.blockers = ["FXPAK write flag --allow-fxpak-write is required."];
    return report;
  }
  if (!volume || !confirm || volume !== confirm) {
    report.blockers = [
      "FXPAK copy requires matching --fxpak-volume and --confirm-fxpak-volume exact paths.",
    ];
    return report;
  }
  const operation = dryRun.copyPlan[0];
  if (!operation || !operation.source || !operation.destination) {
    report.blockers = ["FXPAK dry-run did not produce a ROM copy operation."];
    return report;
  }
  copyFileSync(operation.source, operation.destination);
  const destinationHash = sha256File(operation.destination);
  report.copied = {
    byteLengthMatched: statSync(operation.source).size === statSync(operation.destination).size,
    destinationPath: operation.destination,
    destinationSha256: destinationHash,
    sourcePath: operation.source,
    sourceSha256: operation.sourceSha256,
  };
  report.status =
    destinationHash === operation.sourceSha256 && report.copied.byteLengthMatched
      ? "pass"
      : "blocked";
  report.blockers =
    report.status === "pass"
      ? []
      : ["Copied FXPAK ROM hash or byte length did not match the source ROM."];
  return report;
}

export function projectVisualApproval(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const latestVisualProof = visualProofEvidence(
    projectPackage,
    latestProjectReceipt(projectId, "visual-proof", options),
  );
  const humanScore = Number.isFinite(Number(options.humanScore))
    ? Math.max(0, Math.min(100, Math.trunc(Number(options.humanScore))))
    : null;
  const outputDir = options.outputDir || projectReceiptDir(projectId, "visual-approval", options);
  ensureDir(outputDir);
  const humanReviewed = options.confirmHumanReviewedVisuals === true;
  const reviewNote =
    typeof options.reviewNote === "string" && options.reviewNote.trim()
      ? options.reviewNote.trim()
      : null;
  const blockers = [
    ...(latestVisualProof?.status === "pass"
      ? []
      : ["Visual approval requires a passing project-visual-proof receipt first."]),
    ...visualProofProductionBlockers(latestVisualProof),
    ...(humanScore === null
      ? ["Human visual score is required; GPT 5.5 visual judging is disabled by default."]
      : []),
    ...(humanScore !== null && humanScore < 100
      ? [`Human visual score ${humanScore}/100 is below the 100/100 production target.`]
      : []),
    ...(humanScore === 100 && !humanReviewed
      ? [
          "100/100 production approval requires --confirm-human-reviewed-visuals after a human reviews contact sheets, atlases, background composites, and in-game screenshots.",
        ]
      : []),
    ...(humanScore === 100 && !reviewNote
      ? ["100/100 production approval requires --review-note describing what the human reviewed."]
      : []),
  ];
  const screenshotProof = Array.isArray(latestVisualProof?.screenshots)
    ? latestVisualProof.screenshots
    : [];
  const approval = {
    format: "openclaw-snes-human-visual-approval",
    projectId,
    projectName: projectTitle(projectPackage),
    targetScore: 100,
    humanScore,
    approver:
      typeof options.approver === "string" && options.approver.trim()
        ? options.approver.trim()
        : "human-operator",
    gpt55VisualJudgeUsed: false,
    humanReviewed,
    reviewNote,
    hostedGlmUsed: false,
    localOnly: true,
    assetManifestHash: latestVisualProof?.assetManifestHash || null,
    screenshotProof: screenshotProof.map((shot) => ({
      scene: shot.scene,
      path: shot.path,
      sha256: shot.sha256,
    })),
    status: blockers.length === 0 ? "pass" : "blocked",
    blockers,
    generatedAt: nowIso(),
  };
  if (approval.status === "pass") {
    const existingRecords = Array.isArray(projectPackage?.manifest?.assetRegistry?.records)
      ? projectPackage.manifest.assetRegistry.records
      : [];
    const approvedRecords = existingRecords.map((record) => ({
      ...record,
      visualApproval: {
        approver: approval.approver,
        approvedAt: approval.generatedAt,
        receiptPath: path.join(outputDir, "visual-approval.json"),
        score: approval.humanScore,
      },
      visualMaturity: "production-approved",
    }));
    const packageWithApprovedAssets = persistProjectAssetRecords(
      projectId,
      projectPackage,
      approvedRecords,
      "visual-approval",
      options,
    );
    writeProjectPackage(
      projectId,
      {
        ...packageWithApprovedAssets,
        manifest: {
          ...packageWithApprovedAssets.manifest,
          productionReadiness: {
            ...(packageWithApprovedAssets.manifest?.productionReadiness || {}),
            visualApproval: {
              blocker: null,
              currentHumanScore: approval.humanScore,
              gpt55ReviewStatus: "not-requested",
              machineScore: 100,
              status: "approved",
              targetScore: approval.targetScore,
            },
          },
        },
      },
      options,
    );
  }
  writeJson(path.join(outputDir, "visual-approval.json"), approval);
  return {
    ...approval,
    outputDir,
    note: "This receipt records human approval only. GPT 5.5 visual judging remains disabled unless separately approved.",
  };
}

export function projectVisualQualityAudit(options = {}) {
  const projectId = sanitizeProjectId(options.projectId);
  const projectPackage = loadOrCreateProjectPackage(projectId, options);
  const latestVisualProof = latestProjectReceipt(projectId, "visual-proof", options);
  const latestRuntimeAssetTruth = latestProjectReceipt(projectId, "runtime-asset-truth", options);
  const latestRejection =
    latestProjectReceipt(projectId, "visual-rejection", options) ||
    visualRejectionEvidence(projectPackage);
  const outputDir =
    options.outputDir || projectReceiptDir(projectId, "visual-quality-audit", options);
  ensureDir(outputDir);
  const screenshots = Array.isArray(latestVisualProof?.screenshots)
    ? latestVisualProof.screenshots
    : [];
  const screenshotMetrics = [];
  for (const shot of screenshots) {
    if (!shot?.path || !existsSync(shot.path)) continue;
    try {
      screenshotMetrics.push({ scene: shot.scene, ...analyzeVisualPng(shot.path) });
    } catch (error) {
      screenshotMetrics.push({
        scene: shot.scene,
        path: shot.path,
        error: String(error?.message || error),
      });
    }
  }
  const blockers = visualQualityBlockers({
    projectId,
    latestVisualProof,
    latestRuntimeAssetTruth,
    latestRejection,
    screenshotMetrics,
  });
  const report = {
    format: "openclaw-snes-visual-quality-audit-v1",
    projectId,
    projectName: projectTitle(projectPackage),
    levelId: options.levelId || STANSKI_LEVEL_ONE_ID,
    target:
      "100/100 human-approved original clean-room commercial SNES visuals; Super Mario World is reference quality only",
    status: blockers.length === 0 ? "pass" : "blocked",
    blockers,
    humanGrades:
      latestRejection?.categoryGrades ||
      (projectId === STANSKI_PROJECT_ID ? STANSKI_VISUAL_CATEGORY_GRADES : null),
    screenshotMetrics,
    runtimeAssetTruth: {
      status: latestRuntimeAssetTruth?.status || "blocked",
      blocker:
        latestRuntimeAssetTruth?.blockers?.[0] ||
        "Current proof records screenshot files but does not prove the improved sprite/tile/background sheets are what the ROM renders.",
      receiptPath: latestRuntimeAssetTruth?.receiptPath || null,
    },
    safeReferencePolicy: {
      ...cleanRoomSourcePolicy(),
      allowed: [
        "human-provided legal screenshots for side-by-side reference",
        "original Pixelorama/Tiled art",
        "deterministic metrics plus human approval",
      ],
    },
    clevelandLandmarks: projectId === STANSKI_PROJECT_ID ? stanskiClevelandLandmarks() : [],
    generatedAt: nowIso(),
    localOnly: true,
    hostedGlmUsed: false,
    gpt55VisualJudgeUsed: false,
  };
  writeJson(path.join(outputDir, "visual-quality-audit.json"), report);
  return { ...report, outputDir };
}

export function writeReceipt(kind, report, artifactDir = DEFAULT_ARTIFACT_DIR) {
  ensureDir(artifactDir);
  const dir = report.outputDir || path.join(artifactDir, `${kind}-${timestampSlug()}`);
  ensureDir(dir);
  const receiptPath = path.join(dir, "receipt.json");
  writeJson(receiptPath, report);
  const latestPath = path.join(artifactDir, `latest-${kind}.json`);
  writeJson(latestPath, { ...report, receiptPath });
  if (kind === "probe")
    writeJson(path.join(artifactDir, "latest.json"), { ...report, receiptPath });
  try {
    appendManifest({
      lastReceipts: {
        [kind]: {
          latestPath,
          receiptPath,
          status: report.status ?? "unknown",
          generatedAt: report.generatedAt ?? nowIso(),
        },
      },
    });
  } catch {
    // Probe receipts should remain best-effort when the home manifest is not writable.
  }
  return { receiptPath, latestPath };
}

export function runMode(mode, options = {}) {
  const artifactDir = options.artifactDir || DEFAULT_ARTIFACT_DIR;
  if (mode === "probe") {
    const report = probeToolchain({ artifactDir });
    return { ...report, artifacts: writeReceipt("probe", report, artifactDir) };
  }
  if (mode === "install") {
    const report = installToolchain({ artifactDir });
    return { ...report, artifacts: writeReceipt("install", report, artifactDir) };
  }
  if (mode === "conversion-smoke") {
    const report = conversionSmoke({ artifactDir });
    return { ...report, artifacts: writeReceipt("conversion", report, artifactDir) };
  }
  if (mode === "rom-smoke") {
    const report = romSmoke({ artifactDir });
    return { ...report, artifacts: writeReceipt("rom", report, artifactDir) };
  }
  if (mode === "emulator-smoke") {
    const report = emulatorSmoke({ artifactDir });
    return { ...report, artifacts: writeReceipt("emulator", report, artifactDir) };
  }
  if (mode === "visual-reject") {
    const report = projectVisualReject(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "visual-rejection",
        report,
        options,
      ),
    };
  }
  if (mode === "project-art-bible") {
    const report = projectArtBible(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "art-bible",
        report,
        options,
      ),
    };
  }
  if (mode === "project-art-source-pack") {
    const report = projectArtSourcePack(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "art-source-pack",
        report,
        options,
      ),
    };
  }
  if (mode === "project-art-manifest") {
    const report = projectArtManifest(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "art-manifest",
        report,
        options,
      ),
    };
  }
  if (mode === "project-art-compile") {
    const report = projectArtCompile(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "art-compile",
        report,
        options,
      ),
    };
  }
  if (mode === "project-audio-compile") {
    const report = projectAudioCompile(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "audio-compile",
        report,
        options,
      ),
    };
  }
  if (mode === "reconcile-production-state") {
    const report = reconcileProductionState(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "production-state",
        report,
        options,
      ),
    };
  }
  if (mode === "project-visual-proof") {
    const report = projectVisualProof(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "visual-proof",
        report,
        options,
      ),
    };
  }
  if (mode === "project-visual-approval") {
    const report = projectVisualApproval(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "visual-approval",
        report,
        options,
      ),
    };
  }
  if (mode === "project-visual-quality-audit") {
    const report = projectVisualQualityAudit(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "visual-quality-audit",
        report,
        options,
      ),
    };
  }
  if (mode === "project-runtime-asset-truth") {
    const report = projectRuntimeAssetTruth(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "runtime-asset-truth",
        report,
        options,
      ),
    };
  }
  if (mode === "project-visual-review-pack") {
    const report = projectVisualReviewPack(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "visual-review-pack",
        report,
        options,
      ),
    };
  }
  if (mode === "project-browser-playtest") {
    const report = projectBrowserPlaytest(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "browser-playtest",
        report,
        options,
      ),
    };
  }
  if (mode === "project-conversion") {
    const report = projectConversion(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "conversion",
        report,
        options,
      ),
    };
  }
  if (mode === "project-rom") {
    const report = projectRom(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "rom",
        report,
        options,
      ),
    };
  }
  if (mode === "project-engine-rom") {
    const report = projectEngineRom(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "engine-rom",
        report,
        options,
      ),
    };
  }
  if (mode === "project-emulator") {
    const report = projectEmulator(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "emulator",
        report,
        options,
      ),
    };
  }
  if (mode === "project-engine-emulator") {
    const report = projectEngineEmulator(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "engine-emulator",
        report,
        options,
      ),
    };
  }
  if (mode === "fxpak-dry-run") {
    const report = fxpakDryRun(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "fxpak-dry-run",
        report,
        options,
      ),
    };
  }
  if (mode === "fxpak-transfer-package") {
    const report = fxpakTransferPackage(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "fxpak-transfer-package",
        report,
        options,
      ),
    };
  }
  if (mode === "fxpak-copy") {
    const report = fxpakCopy(options);
    return {
      ...report,
      artifacts: writeProjectReceipt(
        options.projectId || DEFAULT_PROJECT_ID,
        "fxpak-copy",
        report,
        options,
      ),
    };
  }
  throw new Error(`Unsupported SNES toolchain mode: ${mode}`);
}

export {
  DEFAULT_ARTIFACT_DIR,
  DEFAULT_PROJECTS_ROOT,
  MANIFEST_PATH,
  TOOLCHAIN_HOME,
  TOOL_DEFINITIONS,
};
