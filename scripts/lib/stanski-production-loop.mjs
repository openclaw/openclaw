import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { probeLocalLlamaCppGlmRuntime } from "./snes-local-model-benchmark.mjs";

export const STANSKI_DEFAULT_PRODUCTION_DIR = ".artifacts/stanskis-world/production";
export const STANSKI_DEFAULT_ROOT_DIR = ".artifacts/stanskis-world";
export const STANSKI_GLM_MODEL_ID = "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf";
export const STANSKI_GLM_BASE_URL = "http://127.0.0.1:28080";
export const STANSKI_PROMPT_CHAR_BUDGET = 12_000;
export const STANSKI_DEFAULT_MAX_OUTPUT_TOKENS = 900;

const GLM_SYSTEM_PROMPT = [
  "You are local GLM-5.2 inside OpenClaw.",
  "Return one strict JSON object only.",
  "No markdown. No prose. No code blocks. No raw HTML. No raw JavaScript.",
  "Complete only the requested milestone.",
].join(" ");

const DEFAULT_GPT55_POLICY = Object.freeze({
  defaultReasoning: "low",
  useGpt55ForRoutineMilestone: false,
  useGpt55ForQaSummary: "low",
  useGpt55ForRepeatedFailureAfter: 2,
  useHighReasoningFor: [
    "production architecture change",
    "repeated blocker root cause",
    "final 100 visual approval",
    "major gameplay redesign conflict",
  ],
});

export const STANSKI_PRODUCTION_POLICY = Object.freeze({
  version: 1,
  localGlmOnly: true,
  hostedGlmAllowed: false,
  routineGpt55Allowed: false,
  targetHumanVisualGrade: 100,
  publishRequiresExecutableQa: true,
  publishRequiresRemoteProof: true,
  defaultRuntimeCapMinutes: 30,
  staleLockMinutes: 20,
  stopConditions: [
    "human visual approval required",
    "hosted model required",
    "repeated GLM failure",
    "repeated executable QA failure",
    "unsafe mutation requested",
    "pause requested",
    "cancel requested",
    "runtime cap reached",
  ],
});

const STANSKI_PRODUCTION_MODES = new Set([
  "auto",
  "cancel",
  "continue",
  "finish",
  "pause",
  "resume",
  "retry-blocked",
  "split-next",
  "status",
]);

function assetMilestone(id, name, goal, acceptance, patchSchema = "assetPackPatch") {
  return { acceptance, goal, id, name, patchSchema, category: "graphics" };
}

function funMilestone(id, name, goal, acceptance, patchSchema = "levelPatch") {
  return { acceptance, goal, id, name, patchSchema, category: "gameplay" };
}

export const STANSKI_PRODUCTION_BACKLOG = Object.freeze([
  assetMilestone(
    "G01",
    "Production art bible",
    "Define the production art bible for an original SNES-readable Cleveland platformer.",
    [
      "target human visual grade is 100",
      "rules forbid copied Nintendo/Sega/Mario/Sonic/Mortal Kombat assets",
      "palette, outline, shading, animation, UI, and Cleveland scene rules are concrete",
    ],
    "qaRubricPatch",
  ),
  assetMilestone(
    "G02",
    "Replace procedural primitive dependency",
    "Specify the migration away from rectangle/ellipse-only hero, enemy, item, and landmark art.",
    [
      "major game objects use named asset packs",
      "procedural primitives are allowed only as fallback/debug",
      "manifest names replacement packs",
    ],
    "assetPackPatch",
  ),
  assetMilestone(
    "G03",
    "Todd production sprite sheet",
    "Create Todd's production-grade sprite-sheet spec.",
    [
      "at least 50 Todd animation frames",
      "distinct idle/walk/run/jump/fall/gas/crouch/shoot/hurt/death/toilet/title states",
      "visible glasses, long neck, stubble, hair ridge, large nose, slim body, sneakers",
      "no raw HTML or JS",
    ],
    "assetPackPatch",
  ),
  assetMilestone(
    "G04",
    "Todd identity pass",
    "Lock Todd's recognizable identity traits and silhouette rules.",
    [
      "side profile remains recognizable",
      "small and big forms preserve Todd identity",
      "face, posture, and clothing traits are explicit",
    ],
    "assetPackPatch",
  ),
  assetMilestone(
    "G05",
    "Big/Small visual split",
    "Make small and big Stanski visually distinct beyond scaling.",
    ["separate silhouettes", "separate hitbox visual states", "power-up transition described"],
    "assetPackPatch",
  ),
  assetMilestone(
    "G06",
    "Crouch/projectile/gas animation polish",
    "Specify production animation frames for crouch, shooting, gas boost, bad breath, and landing puffs.",
    [
      "crouched projectile origin is visually lower",
      "falling gas boost has clear burst",
      "run gas and double-jump gas are visually distinct",
    ],
    "assetPackPatch",
  ),
  assetMilestone(
    "G07",
    "Cleveland master tileset",
    "Define a production 16x16 Cleveland tileset.",
    [
      "at least 80 terrain/prop tiles",
      "sidewalk, road, pothole, steel, brick, market, bridge, lake, sewer, rooftop tiles included",
      "tile ids and palette ramps are concrete",
    ],
    "assetPackPatch",
  ),
  assetMilestone(
    "G08",
    "Cleveland landmark pixel-art set",
    "Define production landmark chunks for the Cleveland level.",
    [
      "at least 10 landmark chunks",
      "Terminal Tower, Key Tower-inspired skyline, market tower, Rock Hall-like pyramid, bridge guardians, Flats bridges, lake, and riverfront are represented",
      "landmarks are original silhouettes",
    ],
    "assetPackPatch",
  ),
  assetMilestone(
    "G09",
    "Parallax background overhaul",
    "Define production background layers and atmospheric perspective.",
    [
      "at least 10 depth layers",
      "foreground, midground, far skyline, sky, lake, bridges, and haze are separated",
      "camera composition notes included",
    ],
    "assetPackPatch",
  ),
  assetMilestone(
    "G10",
    "Enemy sprite production pass",
    "Define production sprite sheets for every enemy.",
    ["unique silhouettes", "idle/move/attack/hurt/death frames", "readable attack tells"],
    "assetPackPatch",
  ),
  assetMilestone(
    "G11",
    "Item/power-up art pass",
    "Define polished item and power-up sprites.",
    [
      "burgers, burritos, pizza, toilet paper, letters, boxes, checkpoints, and goal art are concrete",
      "pickup animation frames included",
    ],
    "assetPackPatch",
  ),
  assetMilestone(
    "G12",
    "Lighting/shading/palette pass",
    "Define final palette ramps, outlines, highlights, and shadows.",
    ["consistent light direction", "bounded SNES-style palette", "improved color harmony"],
    "assetPackPatch",
  ),
  assetMilestone(
    "G13",
    "Foreground detail pass",
    "Add production foreground detail plan.",
    [
      "street signs, cracks, bolts, water reflections, market stands, birds, steam vents included",
      "details improve scene readability",
    ],
    "assetPackPatch",
  ),
  assetMilestone(
    "G14",
    "Title screen production art",
    "Define production title screen art and animation.",
    [
      "original title composition",
      "Todd attitude/fist pose",
      "Cleveland backdrop",
      "no Sonic copy",
    ],
    "assetPackPatch",
  ),
  assetMilestone(
    "G15",
    "Ending cinematic art",
    "Define production toilet/fireworks/newspaper ending art.",
    ["recognizable toilet", "Todd sits and reads", "exactly two poop drops", "fireworks continue"],
    "assetPackPatch",
  ),
  assetMilestone(
    "G16",
    "Death screen production art",
    "Define production death spectacle art.",
    [
      "Death to Stanski text",
      "splatter and ooze animation",
      "clear restart transition",
      "no Mortal Kombat copy",
    ],
    "assetPackPatch",
  ),
  assetMilestone(
    "G17",
    "Animation timing pass",
    "Define final animation timing and feel.",
    [
      "run, jump, boost, crouch, projectile, death, and ending timing specified",
      "anticipation/follow-through notes included",
    ],
    "assetPackPatch",
  ),
  assetMilestone(
    "G18",
    "Camera composition pass",
    "Define camera and per-screen composition rules.",
    [
      "landmark reveals planned",
      "safe sightlines preserved",
      "screens look intentionally composed",
    ],
    "qaRubricPatch",
  ),
  assetMilestone(
    "G19",
    "Honest visual QA replacement",
    "Define stricter human-aligned visual QA gates.",
    [
      "human grade is separate from synthetic score",
      "100 requires approval",
      "screenshots and asset-pack metrics are required",
    ],
    "qaRubricPatch",
  ),
  assetMilestone(
    "G20",
    "100/100 visual approval gate",
    "Define final production-grade visual approval contract.",
    [
      "human or approved GPT visual review required",
      "all production asset packs present",
      "no primitive fallback visible",
    ],
    "qaRubricPatch",
  ),
  funMilestone(
    "F01",
    "Core feel pass",
    "Tune movement feel and responsiveness.",
    ["walk/run acceleration", "jump and landing", "gas boost and shooting feel crisp"],
    "mechanicPatch",
  ),
  funMilestone(
    "F02",
    "First 30 seconds redesign",
    "Teach core mechanics in the first 30 seconds.",
    [
      "movement, burgers, burrito, gas boost, pizza, and first enemy are introduced",
      "no unfair first contact",
    ],
    "levelPatch",
  ),
  funMilestone(
    "F03",
    "Level structure expansion",
    "Expand Cleveland Level 1 into memorable sections.",
    ["6-8 sections", "challenge escalates", "visual identity changes by section"],
    "levelPatch",
  ),
  funMilestone(
    "F04",
    "Secret route system",
    "Add upper routes, shortcuts, and rewards.",
    ["gas-boost shortcuts", "hidden rooms or bonus caches", "risk/reward paths"],
    "levelPatch",
  ),
  funMilestone(
    "F05",
    "Collectible meta goal",
    "Add an optional meta collectible system.",
    ["letters or souvenirs", "bonus or secret ending hook", "clear progress display"],
    "levelPatch",
  ),
  funMilestone(
    "F06",
    "Checkpoint system",
    "Improve death recovery and checkpoint clarity.",
    ["midpoint checkpoint", "visual checkpoint marker", "death restart remains finishable"],
    "mechanicPatch",
  ),
  funMilestone(
    "F07",
    "Enemy behavior upgrade",
    "Give enemies distinct mechanics.",
    ["jumpers/swoopers/chargers/blockers/traps", "readable tells", "fair counters"],
    "mechanicPatch",
  ),
  funMilestone(
    "F08",
    "Mini-boss encounter",
    "Add a Cleveland-themed mini-boss encounter.",
    ["one mini-boss before finale", "projectile or gas mechanic matters", "fair arena"],
    "levelPatch",
  ),
  funMilestone(
    "F09",
    "Power-up balance",
    "Balance burrito, pizza, gas, and big/small forms.",
    ["power-ups have strengths and limits", "combos are intentional", "no trivialization"],
    "mechanicPatch",
  ),
  funMilestone(
    "F10",
    "Combat feedback",
    "Add stronger hit, projectile, and score feedback.",
    ["hit pause", "knockback", "impact bursts", "score popups"],
    "mechanicPatch",
  ),
  funMilestone(
    "F11",
    "Death/respawn entertainment",
    "Make deaths funny but not annoying.",
    ["death show is entertaining", "duration is bounded", "fast retry"],
    "mechanicPatch",
  ),
  funMilestone(
    "F12",
    "Scoring system",
    "Add richer score and bonus rules.",
    ["burgers, enemies, secrets, speed, no-death bonus", "fireworks multiplier"],
    "mechanicPatch",
  ),
  funMilestone(
    "F13",
    "Level intro/outro flow",
    "Polish intro and victory transitions.",
    ["World/Level card", "section names", "smooth victory transition"],
    "levelPatch",
  ),
  funMilestone(
    "F14",
    "Audio production pass",
    "Define original high-energy 16-bit music and SFX.",
    [
      "original melody guidance",
      "jump/gas/pickup/death/toilet/firework SFX",
      "no copied Sonic music",
    ],
    "assetPackPatch",
  ),
  funMilestone(
    "F15",
    "HUD redesign",
    "Improve HUD clarity and beauty.",
    ["lives, burgers, pizza, letters, gas state readable", "SNES-style UI"],
    "assetPackPatch",
  ),
  funMilestone(
    "F16",
    "Pause/menu screen",
    "Add pause, controls, mute, restart, and proof links.",
    ["clear controls", "fullscreen/mute/restart", "QA receipt link"],
    "releasePatch",
  ),
  funMilestone(
    "F17",
    "Replay/playtest bot",
    "Upgrade deterministic replay coverage.",
    ["finishability", "secrets", "power-ups", "death recovery", "finale"],
    "qaRubricPatch",
  ),
  funMilestone(
    "F18",
    "Fun metrics",
    "Track fun and pacing metrics.",
    ["time to first fun", "reward spacing", "challenge density", "death causes"],
    "qaRubricPatch",
  ),
  funMilestone(
    "F19",
    "Revision loop solidification",
    "Harden the GLM repair loop.",
    [
      "QA failure produces compact repair packet",
      "one retry then blocked",
      "receipts explain blockers",
    ],
    "qaRubricPatch",
  ),
  funMilestone(
    "F20",
    "Production release package",
    "Package final playable proof.",
    [
      "playable link",
      "QA receipt",
      "screenshots",
      "asset manifest",
      "model receipts",
      "versioned build",
    ],
    "releasePatch",
  ),
]);

export function parseStanskiProductionArgs(argv) {
  const args = {
    artifactDir: STANSKI_DEFAULT_PRODUCTION_DIR,
    baseUrl: process.env.OPENCLAW_LOCAL_GLM52_BASE_URL ?? STANSKI_GLM_BASE_URL,
    json: false,
    allowLocalGlmRestart: false,
    maxMilestones: null,
    maxRuntimeMinutes: null,
    maxOutputTokens: null,
    mode: "status",
    model: STANSKI_GLM_MODEL_ID,
    promptCharBudget: STANSKI_PROMPT_CHAR_BUDGET,
    rootDir: STANSKI_DEFAULT_ROOT_DIR,
    runSmoke: true,
    timeoutSeconds: null,
    until: "blocked",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir") args.artifactDir = argv[++index] ?? args.artifactDir;
    else if (arg === "--allow-local-glm-restart") args.allowLocalGlmRestart = true;
    else if (arg === "--base-url") args.baseUrl = argv[++index] ?? args.baseUrl;
    else if (arg === "--json") args.json = true;
    else if (arg === "--max-milestones") args.maxMilestones = Number(argv[++index] ?? 1);
    else if (arg === "--max-runtime-minutes")
      args.maxRuntimeMinutes = Number(argv[++index] ?? args.maxRuntimeMinutes);
    else if (arg === "--max-output-tokens")
      args.maxOutputTokens = Number(argv[++index] ?? args.maxOutputTokens);
    else if (arg === "--mode") args.mode = argv[++index] ?? args.mode;
    else if (arg === "--model") args.model = argv[++index] ?? args.model;
    else if (arg === "--prompt-char-budget")
      args.promptCharBudget = Number(argv[++index] ?? args.promptCharBudget);
    else if (arg === "--root-dir") args.rootDir = argv[++index] ?? args.rootDir;
    else if (arg === "--skip-smoke") args.runSmoke = false;
    else if (arg === "--timeout")
      args.timeoutSeconds = Number(argv[++index] ?? args.timeoutSeconds);
    else if (arg === "--until") args.until = argv[++index] ?? args.until;
    else if (STANSKI_PRODUCTION_MODES.has(arg)) args.mode = arg;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

export function stanskiProductionHelp() {
  return [
    "Usage: pnpm stanski:produce -- --mode status --json",
    "       pnpm stanski:produce -- --mode continue --max-milestones 1 --json",
    "       pnpm stanski:produce -- --mode finish --json",
    "       pnpm stanski:produce -- --mode retry-blocked --json",
    "       pnpm stanski:produce -- --mode split-next --json",
    "       pnpm stanski:produce -- --mode auto --until blocked --max-runtime-minutes 30 --json",
    "       pnpm stanski:produce -- --mode pause|resume|cancel --json",
    "",
    "Runs a stateful GLM production loop where OpenClaw owns milestone state and local GLM returns one strict JSON patch at a time.",
  ].join("\n");
}

function nowIso(deps) {
  return deps.now ? deps.now().toISOString() : new Date().toISOString();
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function repoPath(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  return !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : filePath.split(path.sep).join("/");
}

export function productionPaths(options = {}) {
  const artifactDir = options.artifactDir ?? STANSKI_DEFAULT_PRODUCTION_DIR;
  return {
    artifactDir,
    appliedManifest: path.join(artifactDir, "applied-manifest.json"),
    backlog: path.join(artifactDir, "backlog.json"),
    control: path.join(artifactDir, "control.json"),
    decisionLog: path.join(artifactDir, "decision-log.json"),
    latestSummary: path.join(artifactDir, "latest-summary.md"),
    latestWorkerReceipt: path.join(artifactDir, "latest-worker-receipt.md"),
    memoryCards: path.join(artifactDir, "memory-cards.json"),
    policy: path.join(artifactDir, "production-policy.json"),
    state: path.join(artifactDir, "state.json"),
    workerLock: path.join(artifactDir, "worker.lock"),
  };
}

export function createDefaultState(options = {}, deps = {}) {
  const receiptPath = path.join(
    options.rootDir ?? STANSKI_DEFAULT_ROOT_DIR,
    "executable-qa-receipt.json",
  );
  const receipt = readJson(receiptPath, {});
  return {
    blockedMilestone: null,
    completedMilestones: [],
    currentHumanVisualGrade: 24,
    currentMilestoneId: "G01",
    gpt55UsagePolicy: { ...DEFAULT_GPT55_POLICY },
    lastGoodBuild: path.join(options.rootDir ?? STANSKI_DEFAULT_ROOT_DIR, "index.html"),
    lastReceipt: receiptPath,
    lastSyntheticVisualScore:
      typeof receipt?.visualQuality?.score === "number" ? receipt.visualQuality.score : null,
    targetHumanVisualGrade: 100,
    updatedAt: nowIso(deps),
  };
}

function createDefaultControl(deps = {}) {
  return {
    version: 1,
    paused: false,
    cancelRequested: false,
    updatedAt: nowIso(deps),
  };
}

export function initializeProductionFiles(options = {}, deps = {}) {
  const paths = productionPaths(options);
  ensureDir(paths.artifactDir);
  if (!existsSync(paths.backlog)) {
    writeJson(paths.backlog, { version: 1, milestones: STANSKI_PRODUCTION_BACKLOG });
  }
  if (!existsSync(paths.state)) {
    writeJson(paths.state, createDefaultState(options, deps));
  }
  if (!existsSync(paths.policy)) {
    writeJson(paths.policy, STANSKI_PRODUCTION_POLICY);
  }
  if (!existsSync(paths.control)) {
    writeJson(paths.control, createDefaultControl(deps));
  }
  if (!existsSync(paths.memoryCards)) {
    writeJson(paths.memoryCards, { version: 1, cards: [], compressed: null });
  }
  if (!existsSync(paths.decisionLog)) {
    writeJson(paths.decisionLog, { version: 1, entries: [] });
  }
  if (!existsSync(paths.appliedManifest)) {
    writeJson(paths.appliedManifest, {
      version: 1,
      assetPacks: {},
      levelPatches: [],
      mechanicPatches: [],
      qaRubricPatches: [],
      releasePatches: [],
      appliedPatches: [],
      updatedAt: nowIso(deps),
    });
  }
  return loadProductionSnapshot(options);
}

export function loadProductionSnapshot(options = {}) {
  const paths = productionPaths(options);
  const backlog = readJson(paths.backlog, { version: 1, milestones: STANSKI_PRODUCTION_BACKLOG });
  const control = readJson(paths.control, createDefaultControl());
  const state = readJson(paths.state, createDefaultState(options));
  const memoryCards = readJson(paths.memoryCards, { version: 1, cards: [], compressed: null });
  const decisionLog = readJson(paths.decisionLog, { version: 1, entries: [] });
  const appliedManifest = readJson(paths.appliedManifest, { version: 1 });
  const policy = readJson(paths.policy, STANSKI_PRODUCTION_POLICY);
  return { appliedManifest, backlog, control, decisionLog, memoryCards, paths, policy, state };
}

export function selectNextMilestone(backlog, state, { retryBlocked = false } = {}) {
  const milestones = Array.isArray(backlog?.milestones)
    ? backlog.milestones
    : STANSKI_PRODUCTION_BACKLOG;
  if (retryBlocked && state?.blockedMilestone?.id) {
    return milestones.find((milestone) => milestone.id === state.blockedMilestone.id) ?? null;
  }
  if (state?.blockedMilestone) return null;
  const completed = new Set(
    Array.isArray(state?.completedMilestones) ? state.completedMilestones : [],
  );
  return milestones.find((milestone) => !completed.has(milestone.id)) ?? null;
}

function g07ChildMilestones(parent = {}) {
  const base = {
    category: parent.category ?? "graphics",
    parentId: "G07",
    splitFrom: "G07",
  };
  return [
    {
      ...base,
      id: "G07a",
      name: "Sidewalk, road, and pothole tiles",
      goal: "Define 10-25 production 16x16 Cleveland sidewalk, road, curb, crosswalk, pothole, and street-crack tiles.",
      patchSchema: "assetPackPatch",
      acceptance: [
        "10-25 concrete tile frame specs",
        "sidewalk, curb, asphalt, crosswalk, pothole, crack, and street edge variants included",
        "palette has at least 4 colors",
        "collision or usage notes explain solid, slope, hazard, and decorative usage",
      ],
    },
    {
      ...base,
      id: "G07b",
      name: "Lake, river, bridge, and steel tiles",
      goal: "Define 10-25 production 16x16 Lake Erie, Cuyahoga river, bridge truss, rivet, and steel-beam tiles.",
      patchSchema: "assetPackPatch",
      acceptance: [
        "10-25 concrete tile frame specs",
        "lake shimmer, river edge, truss, rivet, beam, grate, and bridge deck variants included",
        "palette has at least 4 colors",
        "collision or usage notes explain water, platform, and decorative usage",
      ],
    },
    {
      ...base,
      id: "G07c",
      name: "Market, downtown, brick, and window tiles",
      goal: "Define 10-25 production 16x16 West Side Market, downtown brick, window, tower, sign, and facade tiles.",
      patchSchema: "assetPackPatch",
      acceptance: [
        "10-25 concrete tile frame specs",
        "brick, window, market roof, tower, shop sign, skyline light, and stone variants included",
        "palette has at least 4 colors",
        "collision or usage notes explain wall, background, and ledge usage",
      ],
    },
    {
      ...base,
      id: "G07d",
      name: "Sewer, rooftop, and foreground prop tiles",
      goal: "Define 10-25 production 16x16 sewer, rooftop, cone, grate, vent, pipe, sign, and foreground prop tiles.",
      patchSchema: "assetPackPatch",
      acceptance: [
        "10-25 concrete tile frame specs",
        "sewer grate, steam vent, cone, pipe, rooftop trim, sign, trash can, and bolt variants included",
        "palette has at least 4 colors",
        "collision or usage notes explain foreground, hazard, and decorative usage",
      ],
    },
    {
      ...base,
      id: "G07e",
      name: "Tileset palette, collision, and QA integration",
      goal: "Integrate the G07 child asset packs into one QA contract with palette ramps, collision classes, and screenshot checks.",
      patchSchema: "qaRubricPatch",
      acceptance: [
        "references G07a, G07b, G07c, and G07d asset ids",
        "lists palette ramps and collision classes",
        "names screenshot and visual checks for first, middle, and finale screens",
      ],
    },
  ];
}

export function isSplittableMilestone(milestone, reason = null) {
  if (!milestone) return false;
  if (milestone.id === "G07") return true;
  if (reason && /timed out|timeout|invalid json|prompt too large|output budget/i.test(reason)) {
    return milestone.patchSchema === "assetPackPatch";
  }
  const acceptanceText = JSON.stringify(milestone.acceptance ?? []).toLowerCase();
  return (
    milestone.patchSchema === "assetPackPatch" &&
    (/80|broad production|master tileset|large asset/.test(acceptanceText) ||
      /more than 40|40\+|25 frames|8 landmarks/.test(acceptanceText))
  );
}

function splitMilestones(backlog, parentMilestone) {
  const milestones = Array.isArray(backlog?.milestones)
    ? backlog.milestones
    : STANSKI_PRODUCTION_BACKLOG;
  if (milestones.some((milestone) => /^G07[a-e]$/.test(milestone.id))) {
    return { alreadySplit: true, milestones };
  }
  if (parentMilestone?.id !== "G07") {
    return { alreadySplit: false, milestones };
  }
  const children = g07ChildMilestones(parentMilestone);
  return {
    alreadySplit: false,
    milestones: milestones.flatMap((milestone) =>
      milestone.id === parentMilestone.id ? children : [milestone],
    ),
  };
}

export function splitNextMilestone(options = {}, snapshot = null, deps = {}) {
  const current = snapshot ?? loadProductionSnapshot(options);
  const retryBlocked = Boolean(current.state?.blockedMilestone?.id);
  const milestone = selectNextMilestone(current.backlog, current.state, { retryBlocked });
  if (!milestone || !isSplittableMilestone(milestone, current.state?.blockedMilestone?.reason)) {
    return {
      status: "not-splittable",
      milestone,
      split: false,
      nextMilestone: selectNextMilestone(current.backlog, current.state),
    };
  }
  const split = splitMilestones(current.backlog, milestone);
  const firstChild = split.milestones.find(
    (candidate) =>
      candidate.parentId === milestone.id &&
      !current.state.completedMilestones?.includes(candidate.id),
  );
  current.backlog = {
    ...current.backlog,
    version: Math.max(2, Number(current.backlog?.version ?? 1)),
    milestones: split.milestones,
  };
  if (firstChild) current.state.currentMilestoneId = firstChild.id;
  if (current.state.blockedMilestone?.id === milestone.id) current.state.blockedMilestone = null;
  current.state.updatedAt = nowIso(deps);
  writeJson(current.paths.backlog, current.backlog);
  writeJson(current.paths.state, current.state);
  appendDecision(current.paths, {
    type: split.alreadySplit ? "split-already-present" : "split",
    milestoneId: milestone.id,
    childIds: g07ChildMilestones(milestone).map((child) => child.id),
    at: current.state.updatedAt,
  });
  const next = selectNextMilestone(current.backlog, current.state);
  return {
    status: split.alreadySplit ? "already-split" : "split",
    milestone,
    split: true,
    childIds: g07ChildMilestones(milestone).map((child) => child.id),
    nextMilestone: next,
  };
}

function compactMemoryCards(memoryCards, budget = 18) {
  const cards = Array.isArray(memoryCards?.cards) ? memoryCards.cards : [];
  if (cards.length <= budget) return cards;
  return cards.slice(-budget).map((card) => ({
    milestoneId: card.milestoneId,
    status: card.status,
    summary: card.summary,
    lockedDecisions: Array.isArray(card.lockedDecisions) ? card.lockedDecisions.slice(0, 4) : [],
    remainingRisks: Array.isArray(card.remainingRisks) ? card.remainingRisks.slice(0, 2) : [],
  }));
}

function loadLatestReceiptSummary(rootDir = STANSKI_DEFAULT_ROOT_DIR) {
  const receipt = readJson(path.join(rootDir, "executable-qa-receipt.json"), {});
  return {
    humanVisualGrade: 24,
    lastSyntheticScore:
      typeof receipt?.visualQuality?.score === "number" ? receipt.visualQuality.score : null,
    receiptStatus: typeof receipt?.status === "string" ? receipt.status : "missing",
    knownWeakness:
      "User human visual grade is 24/100; current deterministic/procedural art is not production-grade.",
    localGlmOnly: receipt?.localGlmOnly === true,
    hostedGlmUsed: receipt?.hostedGlmUsed === true,
  };
}

export function schemaForPatchType(patchType) {
  if (patchType === "assetPackPatch") {
    return {
      patchType,
      requiredField: "assetPackPatch",
      example: {
        assetPackPatch: {
          assetId: "short-kebab-case-id",
          states: ["state names"],
          frames: [
            { id: "frame-id", state: "idle", durationMs: 100, notes: "pixel-art frame spec" },
          ],
          palette: ["#111827", "#f0c08c"],
          identityTraits: ["visible trait"],
          animationNotes: ["timing or readability note"],
        },
      },
    };
  }
  if (patchType === "mechanicPatch") {
    return {
      patchType,
      requiredField: "mechanicPatch",
      example: {
        mechanicPatch: {
          changes: [{ surface: "jump", value: "specific tuning", reason: "why it improves feel" }],
          constants: [{ name: "gasBoostMultiplier", value: 1.5 }],
          qaChecks: ["specific mechanic assertion"],
        },
      },
    };
  }
  if (patchType === "levelPatch") {
    return {
      patchType,
      requiredField: "levelPatch",
      example: {
        levelPatch: {
          sections: [{ name: "Lakefront tutorial", goal: "teach movement", xStart: 0, xEnd: 900 }],
          items: [{ kind: "cheeseburger", x: 240, y: 164, reason: "first reward" }],
          enemies: [{ name: "Pothole Gremlin", x: 650, y: 170, behavior: "fair first patrol" }],
          secrets: [{ name: "upper gas route", requirement: "falling gas boost" }],
        },
      },
    };
  }
  if (patchType === "releasePatch") {
    return {
      patchType,
      requiredField: "releasePatch",
      example: {
        releasePatch: {
          checklist: ["remote route proof", "receipt link", "screenshots"],
          playerFacingNotes: ["what changed"],
          publishGates: ["local QA pass", "Tailscale route pass"],
        },
      },
    };
  }
  return {
    patchType: "qaRubricPatch",
    requiredField: "qaRubricPatch",
    example: {
      qaRubricPatch: {
        targetScore: 100,
        humanApprovalRequired: true,
        rules: ["human visual grade overrides synthetic score"],
        acceptance: ["screenshots prove production-grade art"],
      },
    },
  };
}

export function resolveMaxOutputTokensForMilestone(options = {}, milestone = {}) {
  if (typeof options.maxOutputTokens === "number" && Number.isFinite(options.maxOutputTokens)) {
    return Math.max(256, Math.trunc(options.maxOutputTokens));
  }
  if (milestone.patchSchema === "assetPackPatch") {
    return milestone.id === "G03" ? 3_600 : 2_800;
  }
  if (milestone.patchSchema === "levelPatch") return 2_400;
  if (milestone.patchSchema === "mechanicPatch") return 1_800;
  if (milestone.patchSchema === "releasePatch") return 1_600;
  return STANSKI_DEFAULT_MAX_OUTPUT_TOKENS;
}

export function resolveTimeoutSecondsForMilestone(options = {}, milestone = {}) {
  if (typeof options.timeoutSeconds === "number" && Number.isFinite(options.timeoutSeconds)) {
    return Math.max(15, Math.trunc(options.timeoutSeconds));
  }
  if (milestone.id === "G03") return 600;
  if (milestone.patchSchema === "assetPackPatch") return 360;
  if (milestone.patchSchema === "levelPatch") return 300;
  return 180;
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function fetchWithAbortTimeout(fetchFn, url, request, timeoutMs, label) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error(`${label} timed out`)), timeoutMs);
  try {
    return await fetchFn(url, {
      ...request,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function postLocalGlmCompletion({ body, fetchFn, options, timeoutMs, url }, deps = {}) {
  if (fetchFn) {
    const response = await fetchWithAbortTimeout(
      fetchFn,
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
      timeoutMs,
      "local GLM request",
    );
    if (!response.ok)
      throw new Error(`local GLM HTTP ${response.status}: ${await response.text()}`);
    return await withTimeout(response.json(), timeoutMs, "local GLM JSON body");
  }
  const spawnSyncFn = deps.spawnSyncFn ?? spawnSync;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const result = spawnSyncFn(
    "curl",
    [
      "-fsS",
      "--max-time",
      String(timeoutSeconds),
      "-H",
      "content-type: application/json",
      "-d",
      body,
      url,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs + 5_000,
      maxBuffer: Math.max(1_000_000, Number(options.maxOutputTokens ?? 1_000) * 8_000),
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `local GLM curl failed with status ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout);
}

export function createMilestonePacket({ backlog, memoryCards, milestone, options = {}, state }) {
  const schema = schemaForPatchType(milestone.patchSchema);
  const packet = {
    task: `Complete milestone ${milestone.id} only.`,
    milestone: {
      id: milestone.id,
      name: milestone.name,
      category: milestone.category,
      goal: milestone.goal,
      acceptance: milestone.acceptance,
    },
    currentStateSummary: loadLatestReceiptSummary(options.rootDir),
    completedMemoryCards: compactMemoryCards(memoryCards),
    progress: {
      completedCount: Array.isArray(state?.completedMilestones)
        ? state.completedMilestones.length
        : 0,
      totalCount: Array.isArray(backlog?.milestones)
        ? backlog.milestones.length
        : STANSKI_PRODUCTION_BACKLOG.length,
      currentHumanVisualGrade: state?.currentHumanVisualGrade ?? 24,
      targetHumanVisualGrade: state?.targetHumanVisualGrade ?? 100,
    },
    allowedPatchSchema: schema,
    requiredResponseContract: {
      milestoneId: milestone.id,
      localGlmOnly: true,
      hostedGlmUsed: false,
      patchType: milestone.patchSchema,
      summary: "short summary",
      ...schema.example,
      qaHypothesis: ["testable claim"],
    },
    doNotBreak: [
      "replay reaches goal",
      "five lives",
      "1.5x gas boost",
      "remote route proof",
      "local GLM only",
      "no copied Nintendo/Sega/Mario/Sonic/Mortal Kombat assets",
    ],
  };
  const text = JSON.stringify(packet);
  if (text.length <= (options.promptCharBudget ?? STANSKI_PROMPT_CHAR_BUDGET)) {
    return packet;
  }
  return {
    ...packet,
    completedMemoryCards: compactMemoryCards(memoryCards, 6),
    compacted: true,
  };
}

export function createGlmMilestonePrompt(packet) {
  return [
    GLM_SYSTEM_PROMPT,
    "Return exactly this response shape with the milestone-specific required patch object.",
    "Keep arrays compact. Use short ids and short notes. Do not explain outside JSON.",
    "If you cannot complete it, return a valid patch with blocker details inside qaHypothesis; do not add prose.",
    JSON.stringify(packet),
  ].join("\n");
}

export function parseStrictGlmJson(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
    throw new Error("GLM response used markdown fences");
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("GLM response must be exactly one JSON object");
  }
  return JSON.parse(trimmed);
}

function hasRawCode(value) {
  const text = JSON.stringify(value).toLowerCase();
  return ["<script", "</script", "document.", "window.", "function(", "=>", "import "].some(
    (needle) => text.includes(needle),
  );
}

function hasForbiddenCopiedAssetLanguage(value) {
  const text = JSON.stringify(value).toLowerCase();
  const needles = [
    "copy from nintendo",
    "copied from nintendo",
    "use nintendo asset",
    "copy from sega",
    "copied from sega",
    "use sega asset",
    "copy mario",
    "copied mario",
    "use mario",
    "copy sonic",
    "copied sonic",
    "use sonic",
    "use mortal kombat",
    "mortal kombat copy",
  ];
  return needles.some((needle) => {
    let index = text.indexOf(needle);
    while (index >= 0) {
      const prefix = text.slice(Math.max(0, index - 28), index);
      if (!/\b(no|not|never|avoid|forbid|forbidden|without|do not|don't)\b/.test(prefix)) {
        return true;
      }
      index = text.indexOf(needle, index + needle.length);
    }
    return false;
  });
}

function isLocalGlmContextSizeError(reason) {
  return /exceeds the available context size|exceed_context_size_error|n_ctx/i.test(
    String(reason ?? ""),
  );
}

function restartLocalGlmForProduction(options, paths, milestone, deps = {}) {
  const spawnSyncFn = deps.spawnSyncFn ?? spawnSync;
  const restart = spawnSyncFn(
    "pnpm",
    [
      "glm52:runtime",
      "--",
      "restart",
      "--profile",
      "metal-agent-8k",
      "--startup-timeout",
      "900",
      "--timeout",
      "60",
      "--json",
    ],
    { encoding: "utf8", timeout: 960_000 },
  );
  appendDecision(paths, {
    type: "local-glm-restart",
    milestoneId: milestone?.id ?? null,
    profile: "metal-agent-8k",
    status: restart.status,
    at: nowIso(deps),
  });
  return restart;
}

function assertArray(value, name, min = 1) {
  if (!Array.isArray(value) || value.length < min) {
    throw new Error(`${name} must contain at least ${min} item(s)`);
  }
}

export function validateGlmMilestonePatch(patch, milestone) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("patch must be an object");
  if (patch.milestoneId !== milestone.id)
    throw new Error(`patch milestoneId must be ${milestone.id}`);
  if (patch.localGlmOnly !== true) throw new Error("patch.localGlmOnly must be true");
  if (patch.hostedGlmUsed !== false) throw new Error("patch.hostedGlmUsed must be false");
  if (patch.patchType !== milestone.patchSchema)
    throw new Error(`patch.patchType must be ${milestone.patchSchema}`);
  if (typeof patch.summary !== "string" || !patch.summary.trim())
    throw new Error("patch.summary is required");
  assertArray(patch.qaHypothesis, "patch.qaHypothesis");
  if (hasRawCode(patch)) throw new Error("patch contains raw HTML or JavaScript");
  if (hasForbiddenCopiedAssetLanguage(patch)) {
    throw new Error("patch contains copied-asset language");
  }
  const schema = schemaForPatchType(milestone.patchSchema);
  const payload = patch[schema.requiredField];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`patch.${schema.requiredField} is required`);
  }
  if (milestone.patchSchema === "assetPackPatch") {
    if (typeof payload.assetId !== "string" || !payload.assetId.trim())
      throw new Error("assetPackPatch.assetId is required");
    assertArray(payload.states, "assetPackPatch.states");
    assertArray(payload.frames, "assetPackPatch.frames");
    assertArray(payload.palette, "assetPackPatch.palette", 2);
    assertArray(payload.identityTraits, "assetPackPatch.identityTraits");
    if (/^G07[a-d]$/.test(milestone.id)) {
      assertArray(payload.frames, "assetPackPatch.frames", 10);
      assertArray(payload.palette, "assetPackPatch.palette", 4);
      assertArray(payload.animationNotes, "assetPackPatch.animationNotes");
      const usageText = JSON.stringify([
        payload.animationNotes,
        payload.usageNotes,
        payload.collisionNotes,
        payload.collision,
        payload.frames,
      ]).toLowerCase();
      if (
        !/collision|solid|platform|decorative|hazard|foreground|water|ledge|usage/.test(usageText)
      ) {
        throw new Error("G07 child asset patch must include collision or usage notes");
      }
    }
  } else if (milestone.patchSchema === "levelPatch") {
    assertArray(payload.sections, "levelPatch.sections");
  } else if (milestone.patchSchema === "mechanicPatch") {
    assertArray(payload.changes, "mechanicPatch.changes");
  } else if (milestone.patchSchema === "qaRubricPatch") {
    assertArray(payload.rules, "qaRubricPatch.rules");
    assertArray(payload.acceptance, "qaRubricPatch.acceptance");
    if (milestone.id === "G07e") {
      assertArray(payload.childAssetIds, "qaRubricPatch.childAssetIds", 4);
      assertArray(payload.collisionClasses, "qaRubricPatch.collisionClasses", 3);
      assertArray(payload.paletteRamps, "qaRubricPatch.paletteRamps", 3);
      const childText = JSON.stringify(payload.childAssetIds).toLowerCase();
      for (const childId of ["g07a", "g07b", "g07c", "g07d"]) {
        if (!childText.includes(childId)) {
          throw new Error(`qaRubricPatch.childAssetIds must reference ${childId}`);
        }
      }
      const qaText = JSON.stringify([
        payload.rules,
        payload.acceptance,
        payload.screenshotChecks,
      ]).toLowerCase();
      if (!/screenshot|visual|first|middle|finale/.test(qaText)) {
        throw new Error("G07e QA patch must name screenshot or visual checks");
      }
    }
  } else if (milestone.patchSchema === "releasePatch") {
    assertArray(payload.checklist, "releasePatch.checklist");
  }
  return patch;
}

export async function askLocalGlmForMilestonePatch(
  { milestone, options, packet, retryReason = null },
  deps = {},
) {
  const fetchFn = deps.fetchFn;
  const prompt = createGlmMilestonePrompt(
    retryReason
      ? {
          ...packet,
          retryInstruction: `Previous attempt failed: ${retryReason}. Return smaller strict JSON.`,
          completedMemoryCards: [],
        }
      : packet,
  );
  const timeoutMs = resolveTimeoutSecondsForMilestone(options, milestone) * 1000;
  const requestBody = JSON.stringify({
    model: options.model ?? STANSKI_GLM_MODEL_ID,
    messages: [
      { role: "system", content: GLM_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: retryReason ? 0.1 : 0.22,
    top_p: 0.82,
    response_format: { type: "json_object" },
    max_tokens: resolveMaxOutputTokensForMilestone(options, milestone),
  });
  const body = await postLocalGlmCompletion(
    {
      body: requestBody,
      fetchFn,
      options,
      timeoutMs,
      url: `${options.baseUrl}/v1/chat/completions`,
    },
    deps,
  );
  const raw = body?.choices?.[0]?.message?.content ?? "";
  const patch = validateGlmMilestonePatch(parseStrictGlmJson(raw), milestone);
  return {
    patch,
    prompt,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    raw,
    responseModel: body?.model ?? null,
    timings: body?.timings ?? null,
    usage: body?.usage ?? null,
  };
}

export function applyMilestonePatch({ artifactDir, milestone, patch }, deps = {}) {
  const paths = productionPaths({ artifactDir });
  const manifest = readJson(paths.appliedManifest, {
    version: 1,
    assetPacks: {},
    levelPatches: [],
    mechanicPatches: [],
    qaRubricPatches: [],
    releasePatches: [],
    appliedPatches: [],
  });
  const applied = {
    appliedAt: nowIso(deps),
    milestoneId: milestone.id,
    patchType: patch.patchType,
    summary: patch.summary,
  };
  if (patch.patchType === "assetPackPatch") {
    manifest.assetPacks[patch.assetPackPatch.assetId] = {
      milestoneId: milestone.id,
      ...patch.assetPackPatch,
    };
  } else if (patch.patchType === "levelPatch") {
    manifest.levelPatches.push({ milestoneId: milestone.id, ...patch.levelPatch });
  } else if (patch.patchType === "mechanicPatch") {
    manifest.mechanicPatches.push({ milestoneId: milestone.id, ...patch.mechanicPatch });
  } else if (patch.patchType === "releasePatch") {
    manifest.releasePatches.push({ milestoneId: milestone.id, ...patch.releasePatch });
  } else {
    manifest.qaRubricPatches.push({ milestoneId: milestone.id, ...patch.qaRubricPatch });
  }
  manifest.appliedPatches.push(applied);
  manifest.updatedAt = applied.appliedAt;
  writeJson(paths.appliedManifest, manifest);
  return { applied, manifestPath: repoPath(paths.appliedManifest), status: "pass" };
}

export function createMilestoneMemoryCard({ applyReceipt, milestone, patch, qaReceipt }) {
  const payload =
    patch[`${patch.patchType}`] ??
    patch.assetPackPatch ??
    patch.levelPatch ??
    patch.mechanicPatch ??
    patch.qaRubricPatch ??
    patch.releasePatch ??
    {};
  return {
    milestoneId: milestone.id,
    status: "pass",
    summary: patch.summary,
    changedSurfaces: [patch.patchType],
    assetsAdded: patch.assetPackPatch?.assetId ? [patch.assetPackPatch.assetId] : [],
    lockedDecisions: Array.isArray(payload.identityTraits)
      ? payload.identityTraits.slice(0, 6)
      : Array.isArray(payload.rules)
        ? payload.rules.slice(0, 6)
        : milestone.acceptance.slice(0, 4),
    qaProof: {
      patchValidated: true,
      smokePass: qaReceipt.status === "pass",
      manifestPath: applyReceipt.manifestPath,
    },
    remainingRisks: ["human visual grade still pending until user reviews screenshots"],
  };
}

export function runBuildAndSmoke(options, deps = {}) {
  if (!options.runSmoke) {
    return { status: "pass", skipped: true, reason: "--skip-smoke used" };
  }
  const spawnSyncFn = deps.spawnSyncFn ?? spawnSync;
  const build = spawnSyncFn(
    "node",
    [path.join(options.rootDir, "build-revised-playable.mjs"), "--json"],
    {
      encoding: "utf8",
      timeout: Math.max(30_000, (options.timeoutSeconds ?? 180) * 1000),
    },
  );
  if (build.status !== 0) {
    return { status: "fail", step: "build", stdout: build.stdout, stderr: build.stderr };
  }
  const smokeOut = path.join(options.rootDir, "production-smoke-latest.json");
  const url = `file://${path.resolve(path.join(options.rootDir, "index.html"))}`;
  const smoke = spawnSyncFn(
    "node",
    [
      path.join(options.rootDir, "stanskis-world-smoke.mjs"),
      "--url",
      url,
      "--out",
      smokeOut,
      "--json",
    ],
    { encoding: "utf8", timeout: Math.max(60_000, (options.timeoutSeconds ?? 180) * 1000) },
  );
  if (smoke.status !== 0) {
    return { status: "fail", step: "smoke", stdout: smoke.stdout, stderr: smoke.stderr, smokeOut };
  }
  const receipt = readJson(smokeOut, null);
  const rendererImpact = validateProductionRendererImpact({ options, receipt });
  if (rendererImpact.status !== "pass") {
    return {
      status: "fail",
      step: "production-renderer-impact",
      receiptPath: repoPath(smokeOut),
      receiptSummary: receipt
        ? {
            status: receipt.status,
            visualScore: receipt.proof?.quality?.score ?? null,
            checks: Array.isArray(receipt.checks) ? receipt.checks.length : 0,
          }
        : null,
      rendererImpact,
    };
  }
  return {
    status: receipt?.status === "pass" ? "pass" : "fail",
    receiptPath: repoPath(smokeOut),
    receiptSummary: receipt
      ? {
          status: receipt.status,
          visualScore: receipt.proof?.quality?.score ?? null,
          checks: Array.isArray(receipt.checks) ? receipt.checks.length : 0,
          failedChecks: Array.isArray(receipt.checks)
            ? receipt.checks.filter((check) => check?.pass !== true).map((check) => check?.code)
            : [],
        }
      : null,
    rendererImpact,
  };
}

function readTextIfExists(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function checkPassed(receipt, code) {
  return Array.isArray(receipt?.checks)
    ? receipt.checks.some((check) => check?.code === code && check?.pass === true)
    : false;
}

function productionSummaryFrom(proof, bundle) {
  return proof?.productionManifestSummary ?? bundle?.productionManifestSummary ?? null;
}

function mediaStatusFrom(proof, bundle, receipt) {
  return (
    proof?.mediaStatus ??
    bundle?.mediaStatus ??
    receipt?.proof?.media ??
    receipt?.proof?.art?.media ??
    null
  );
}

export function validateProductionRendererImpact({
  options = {},
  receipt = null,
  snapshot = null,
} = {}) {
  const currentSnapshot = snapshot ?? loadProductionSnapshot(options);
  const rootDir = options.rootDir ?? STANSKI_DEFAULT_ROOT_DIR;
  const qaReceipt =
    receipt ??
    (currentSnapshot.state?.lastReceipt ? readJson(currentSnapshot.state.lastReceipt, null) : null);
  const htmlPath = path.join(rootDir, "index.html");
  const proofPath = path.join(rootDir, "playable-proof.json");
  const bundlePath = path.join(rootDir, "stanskis-world.revised.oc-snes-bundle.json");
  const html = readTextIfExists(htmlPath) ?? "";
  const proof = readJson(proofPath, null);
  const bundle = readJson(bundlePath, null);
  const manifest = currentSnapshot.appliedManifest ?? {};
  const appliedCount = Array.isArray(manifest.appliedPatches) ? manifest.appliedPatches.length : 0;
  const assetPackCount =
    manifest.assetPacks && typeof manifest.assetPacks === "object"
      ? Object.keys(manifest.assetPacks).length
      : 0;
  const completedCount = Array.isArray(currentSnapshot.state?.completedMilestones)
    ? currentSnapshot.state.completedMilestones.length
    : 0;
  const totalCount = Array.isArray(currentSnapshot.backlog?.milestones)
    ? currentSnapshot.backlog.milestones.length
    : 0;
  const productionComplete = totalCount > 0 && completedCount >= totalCount;
  const failures = [];
  const summary = productionSummaryFrom(proof, bundle);
  const mediaStatus = mediaStatusFrom(proof, bundle, qaReceipt);

  if (appliedCount > 0) {
    if (!summary || typeof summary !== "object") {
      failures.push("generated playable proof must include productionManifestSummary");
    } else {
      if (summary.appliedPatches !== appliedCount) {
        failures.push(
          `generated playable appliedPatches ${summary.appliedPatches ?? "missing"} does not match manifest ${appliedCount}`,
        );
      }
      if (summary.assetPacks !== assetPackCount) {
        failures.push(
          `generated playable assetPacks ${summary.assetPacks ?? "missing"} does not match manifest ${assetPackCount}`,
        );
      }
    }
    if (!html.includes("productionManifestSummary") || !html.includes("appliedPatches")) {
      failures.push("generated HTML does not embed production manifest summary");
    }
  }

  if (productionComplete) {
    const buildLabel = `${proof?.buildLabel ?? ""} ${proof?.title ?? ""} ${html.slice(0, 2000)}`;
    if (!/visual|sprite|image/i.test(buildLabel)) {
      failures.push(
        "complete production build must identify the visual/sprite renderer in its proof",
      );
    }
    if (!html.includes("drawImage(")) {
      failures.push(
        "complete production build must render at least one real image/sprite via drawImage",
      );
    }
    if (!html.includes("toddProductionSpriteDataUrl")) {
      failures.push("complete production build must embed the Todd production sprite data URL");
    }
    if (!checkPassed(qaReceipt, "snes-image-asset-present")) {
      failures.push("complete production QA must pass snes-image-asset-present");
    }
    const titleAssetStatus =
      mediaStatus?.titleAsset?.status ?? qaReceipt?.proof?.media?.titleAsset?.status ?? null;
    if (titleAssetStatus !== "pass") {
      failures.push("complete production proof must include a passed local title/image asset");
    }
  }

  return {
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    appliedCount,
    assetPackCount,
    completedCount,
    totalCount,
    productionComplete,
    paths: {
      bundle: repoPath(bundlePath),
      html: repoPath(htmlPath),
      proof: repoPath(proofPath),
    },
  };
}

function appendDecision(paths, entry) {
  const log = readJson(paths.decisionLog, { version: 1, entries: [] });
  log.entries.push(entry);
  writeJson(paths.decisionLog, log);
}

function writeSummary(snapshot, options = {}) {
  const paths = productionPaths(options);
  const milestones = Array.isArray(snapshot.backlog?.milestones) ? snapshot.backlog.milestones : [];
  const completed = new Set(snapshot.state.completedMilestones ?? []);
  const pending = milestones.find((milestone) => !completed.has(milestone.id));
  const lines = [
    "# Stanski’s World GLM Production Loop",
    "",
    `Status: ${snapshot.state.blockedMilestone ? "blocked" : pending ? "ready" : "complete"}`,
    `Completed: ${completed.size}/${milestones.length}`,
    `Next milestone: ${pending ? `${pending.id} ${pending.name}` : "none"}`,
    `Human visual grade: ${snapshot.state.currentHumanVisualGrade}/100`,
    `Target visual grade: ${snapshot.state.targetHumanVisualGrade}/100`,
    `GPT 5.5 default reasoning: ${snapshot.state.gpt55UsagePolicy?.defaultReasoning ?? "low"}`,
    `Routine GPT 5.5 use: ${snapshot.state.gpt55UsagePolicy?.useGpt55ForRoutineMilestone ? "enabled" : "disabled"}`,
  ];
  if (snapshot.state.blockedMilestone) {
    lines.push(
      `Blocked: ${snapshot.state.blockedMilestone.id} ${snapshot.state.blockedMilestone.reason}`,
    );
  }
  writeFileSync(paths.latestSummary, `${lines.join("\n")}\n`);
}

function policySummary(policy = STANSKI_PRODUCTION_POLICY) {
  return {
    localGlmOnly: policy.localGlmOnly === true,
    hostedGlmAllowed: policy.hostedGlmAllowed === true,
    routineGpt55Allowed: policy.routineGpt55Allowed === true,
    targetHumanVisualGrade: policy.targetHumanVisualGrade ?? 100,
    publishRequiresExecutableQa: policy.publishRequiresExecutableQa === true,
    publishRequiresRemoteProof: policy.publishRequiresRemoteProof === true,
  };
}

function readLock(paths) {
  return readJson(paths.workerLock, null);
}

function isProcessAlive(pid, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (typeof deps.isProcessAlive === "function") return deps.isProcessAlive(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockIsActive(lock, paths, deps = {}, policy = STANSKI_PRODUCTION_POLICY) {
  if (!lock || typeof lock !== "object") return false;
  const pid = Number(lock.pid);
  if (!isProcessAlive(pid, deps)) return false;
  const staleMs = Number(policy.staleLockMinutes ?? 20) * 60_000;
  const heartbeatMs = Date.parse(lock.heartbeatAt ?? lock.startedAt ?? "");
  if (Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs > staleMs) return false;
  try {
    return statSync(paths.workerLock).isFile();
  } catch {
    return false;
  }
}

function acquireWorkerLock(paths, options = {}, deps = {}, policy = STANSKI_PRODUCTION_POLICY) {
  const existing = readLock(paths);
  if (lockIsActive(existing, paths, deps, policy)) {
    return {
      acquired: false,
      blocker: `Stanski production worker already running with pid ${existing.pid}`,
      lock: existing,
    };
  }
  const at = nowIso(deps);
  const lock = {
    version: 1,
    pid: process.pid,
    mode: options.mode,
    startedAt: at,
    heartbeatAt: at,
  };
  writeJson(paths.workerLock, lock);
  return { acquired: true, lock };
}

function heartbeatWorkerLock(paths, deps = {}) {
  const lock = readLock(paths);
  if (!lock) return;
  writeJson(paths.workerLock, { ...lock, heartbeatAt: nowIso(deps) });
}

function releaseWorkerLock(paths) {
  try {
    unlinkSync(paths.workerLock);
  } catch {
    // Best effort: stale locks are recoverable by pid/heartbeat checks.
  }
}

function updateControl(paths, patch, deps = {}) {
  const control = readJson(paths.control, createDefaultControl(deps));
  const next = { ...control, ...patch, updatedAt: nowIso(deps) };
  writeJson(paths.control, next);
  return next;
}

function writeWorkerReceipt(snapshot, options = {}, stopReason = "status", blocker = null) {
  const next = selectNextMilestone(snapshot.backlog, snapshot.state);
  const paths = productionPaths(options);
  const lastGlmPatchPath = inferLastGlmPatchPath(snapshot);
  const lines = [
    "# Stanski’s World Production Worker Receipt",
    "",
    `Completed count: ${snapshot.state.completedMilestones?.length ?? 0}/${snapshot.backlog.milestones?.length ?? 0}`,
    `Current milestone: ${next ? `${next.id} ${next.name}` : "none"}`,
    `Stop reason: ${stopReason}`,
    `Blocker: ${blocker ?? snapshot.state.blockedMilestone?.reason ?? "none"}`,
    `Next action: ${
      snapshot.state.blockedMilestone
        ? "retry blocked milestone or split if supported"
        : next
          ? `continue ${next.id}`
          : "final visual approval and remote playable proof"
    }`,
    `GLM model: ${options.model ?? STANSKI_GLM_MODEL_ID}`,
    "Hosted GLM used: no",
    `GPT 5.5 used: ${
      snapshot.state.gpt55UsagePolicy?.useGpt55ForRoutineMilestone ? "policy-enabled" : "no"
    }`,
    `Last GLM patch path: ${snapshot.state.lastGlmPatchPath ?? lastGlmPatchPath ?? "unknown"}`,
    `Last QA receipt path: ${snapshot.state.lastReceipt ?? "unknown"}`,
    `Policy path: ${repoPath(paths.policy)}`,
  ];
  writeFileSync(paths.latestWorkerReceipt, `${lines.join("\n")}\n`);
}

function inferLastGlmPatchPath(snapshot) {
  const completed = Array.isArray(snapshot.state?.completedMilestones)
    ? snapshot.state.completedMilestones
    : [];
  const lastCompleted = completed.at(-1);
  if (!lastCompleted) return null;
  return repoPath(
    path.join(snapshot.paths.artifactDir, `milestone-${lastCompleted}`, "glm-response.json"),
  );
}

export async function runOneMilestone(options, snapshot, deps = {}) {
  const retryBlocked = options.mode === "retry-blocked";
  const milestone = selectNextMilestone(snapshot.backlog, snapshot.state, { retryBlocked });
  if (!milestone) {
    return { status: snapshot.state.blockedMilestone ? "blocked" : "complete", milestone: null };
  }
  const paths = snapshot.paths;
  const milestoneDir = path.join(paths.artifactDir, `milestone-${milestone.id}`);
  ensureDir(milestoneDir);
  const packet = createMilestonePacket({
    backlog: snapshot.backlog,
    memoryCards: snapshot.memoryCards,
    milestone,
    options,
    state: snapshot.state,
  });
  writeJson(path.join(milestoneDir, "glm-prompt.json"), packet);
  const promptText = createGlmMilestonePrompt(packet);
  if (promptText.length > (options.promptCharBudget ?? STANSKI_PROMPT_CHAR_BUDGET)) {
    throw new Error(`milestone prompt too large: ${promptText.length} chars`);
  }
  const probeFn = deps.probeFn ?? probeLocalLlamaCppGlmRuntime;
  let diagnostic = probeFn(undefined, {
    baseUrl: options.baseUrl,
    maxOutputTokens: 32,
    timeoutSeconds: Math.min(30, options.timeoutSeconds ?? 180),
  });
  if (diagnostic.decodeReady !== true && options.allowLocalGlmRestart === true) {
    restartLocalGlmForProduction(options, paths, milestone, deps);
    diagnostic = probeFn(undefined, {
      baseUrl: options.baseUrl,
      maxOutputTokens: 32,
      timeoutSeconds: Math.min(30, options.timeoutSeconds ?? 180),
    });
  }
  if (diagnostic.decodeReady !== true) {
    const blocked = {
      id: milestone.id,
      name: milestone.name,
      reason: diagnostic.blocker ?? "local GLM-5.2 decode probe is not ready",
      blockedAt: nowIso(deps),
    };
    snapshot.state.blockedMilestone = blocked;
    snapshot.state.currentMilestoneId = milestone.id;
    snapshot.state.updatedAt = nowIso(deps);
    writeJson(paths.state, snapshot.state);
    appendDecision(paths, {
      type: "blocked",
      milestoneId: milestone.id,
      reason: blocked.reason,
      at: blocked.blockedAt,
    });
    return { status: "blocked", milestone, blocker: blocked.reason };
  }

  let glm;
  let firstError = null;
  try {
    glm = await askLocalGlmForMilestonePatch({ milestone, options, packet }, deps);
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
    if (isLocalGlmContextSizeError(firstError) && options.allowLocalGlmRestart === true) {
      restartLocalGlmForProduction(options, paths, milestone, deps);
    }
    try {
      glm = await askLocalGlmForMilestonePatch(
        { milestone, options, packet, retryReason: firstError },
        deps,
      );
    } catch (retryError) {
      const retryReason = retryError instanceof Error ? retryError.message : String(retryError);
      const blocked = {
        id: milestone.id,
        name: milestone.name,
        reason: `local GLM patch failed strict validation after retry: ${retryReason}`,
        firstError,
        blockedAt: nowIso(deps),
      };
      snapshot.state.blockedMilestone = blocked;
      snapshot.state.currentMilestoneId = milestone.id;
      snapshot.state.updatedAt = nowIso(deps);
      writeJson(paths.state, snapshot.state);
      const glmResponsePath = path.join(milestoneDir, "glm-response.json");
      writeJson(glmResponsePath, {
        localGlmOnly: true,
        hostedGlmUsed: false,
        model: options.model,
        retryReason: firstError,
        blocker: blocked.reason,
        generatedAt: blocked.blockedAt,
      });
      snapshot.state.lastGlmPatchPath = repoPath(glmResponsePath);
      writeJson(paths.state, snapshot.state);
      appendDecision(paths, {
        type: "blocked",
        milestoneId: milestone.id,
        reason: blocked.reason,
        firstError,
        at: blocked.blockedAt,
      });
      return { status: "blocked", milestone, blocker: blocked.reason, firstError };
    }
  }
  const glmResponsePath = path.join(milestoneDir, "glm-response.json");
  writeJson(glmResponsePath, {
    localGlmOnly: true,
    hostedGlmUsed: false,
    model: options.model,
    promptSha256: glm.promptSha256,
    retryReason: firstError,
    responseModel: glm.responseModel,
    raw: glm.raw,
    patch: glm.patch,
    usage: glm.usage,
    timings: glm.timings,
    generatedAt: nowIso(deps),
  });

  let applyReceipt = applyMilestonePatch(
    { artifactDir: paths.artifactDir, milestone, patch: glm.patch },
    deps,
  );
  let acceptedGlmResponsePath = glmResponsePath;
  writeJson(path.join(milestoneDir, "apply-receipt.json"), applyReceipt);
  let qaReceipt = runBuildAndSmoke(options, deps);
  writeJson(path.join(milestoneDir, "qa-receipt.json"), qaReceipt);
  if (qaReceipt.status !== "pass") {
    let repairGlm = null;
    let repairApplyReceipt = null;
    let repairQaReceipt = null;
    try {
      repairGlm = await askLocalGlmForMilestonePatch(
        {
          milestone,
          options,
          packet,
          retryReason: `Executable QA failed at ${qaReceipt.step ?? "unknown step"}: ${JSON.stringify(
            qaReceipt.receiptSummary ?? qaReceipt,
          ).slice(0, 800)}`,
        },
        deps,
      );
      const repairResponsePath = path.join(milestoneDir, "glm-repair-response.json");
      writeJson(repairResponsePath, {
        localGlmOnly: true,
        hostedGlmUsed: false,
        model: options.model,
        promptSha256: repairGlm.promptSha256,
        retryReason: "executable QA repair",
        responseModel: repairGlm.responseModel,
        raw: repairGlm.raw,
        patch: repairGlm.patch,
        usage: repairGlm.usage,
        timings: repairGlm.timings,
        generatedAt: nowIso(deps),
      });
      repairApplyReceipt = applyMilestonePatch(
        { artifactDir: paths.artifactDir, milestone, patch: repairGlm.patch },
        deps,
      );
      writeJson(path.join(milestoneDir, "repair-apply-receipt.json"), repairApplyReceipt);
      repairQaReceipt = runBuildAndSmoke(options, deps);
      writeJson(path.join(milestoneDir, "repair-qa-receipt.json"), repairQaReceipt);
      if (repairQaReceipt.status === "pass") {
        glm = repairGlm;
        applyReceipt = repairApplyReceipt;
        acceptedGlmResponsePath = repairResponsePath;
        qaReceipt = repairQaReceipt;
      }
    } catch (error) {
      repairQaReceipt = {
        status: "fail",
        step: "glm-repair",
        stderr: error instanceof Error ? error.message : String(error),
      };
      writeJson(path.join(milestoneDir, "repair-qa-receipt.json"), repairQaReceipt);
    }
  }
  if (qaReceipt.status !== "pass") {
    const blocked = {
      id: milestone.id,
      name: milestone.name,
      reason: `executable QA failed after one repair attempt at ${qaReceipt.step ?? "unknown step"}`,
      blockedAt: nowIso(deps),
    };
    snapshot.state.blockedMilestone = blocked;
    snapshot.state.currentMilestoneId = milestone.id;
    snapshot.state.updatedAt = nowIso(deps);
    writeJson(paths.state, snapshot.state);
    appendDecision(paths, {
      type: "blocked",
      milestoneId: milestone.id,
      reason: blocked.reason,
      at: blocked.blockedAt,
    });
    return { status: "blocked", milestone, blocker: blocked.reason, qaReceipt };
  }

  const card = createMilestoneMemoryCard({ applyReceipt, milestone, patch: glm.patch, qaReceipt });
  snapshot.memoryCards.cards = [...(snapshot.memoryCards.cards ?? []), card];
  writeJson(paths.memoryCards, snapshot.memoryCards);
  snapshot.state.completedMilestones = [
    ...new Set([...(snapshot.state.completedMilestones ?? []), milestone.id]),
  ];
  const next = selectNextMilestone(snapshot.backlog, { ...snapshot.state, blockedMilestone: null });
  snapshot.state.blockedMilestone = null;
  snapshot.state.currentMilestoneId = next?.id ?? null;
  snapshot.state.lastGoodBuild = path.join(options.rootDir, "index.html");
  snapshot.state.lastGlmPatchPath = repoPath(acceptedGlmResponsePath);
  snapshot.state.lastReceipt = qaReceipt.receiptPath ?? snapshot.state.lastReceipt;
  snapshot.state.updatedAt = nowIso(deps);
  writeJson(paths.state, snapshot.state);
  appendDecision(paths, {
    type: "completed",
    milestoneId: milestone.id,
    at: snapshot.state.updatedAt,
    patchType: glm.patch.patchType,
  });
  return { status: "pass", milestone, memoryCard: card, qaReceipt };
}

export async function runStanskiProduction(args = {}, deps = {}) {
  const options = { ...parseStanskiProductionArgs([]), ...args };
  if (options.mode === "finish") {
    options.mode = "auto";
    options.allowLocalGlmRestart = true;
    options.maxMilestones ??= 1_000;
    options.maxRuntimeMinutes ??= 240;
  }
  if (!STANSKI_PRODUCTION_MODES.has(options.mode)) {
    throw new Error(`Unsupported Stanski production mode: ${options.mode}`);
  }
  initializeProductionFiles(options, deps);
  let snapshot = loadProductionSnapshot(options);
  const statusReport = (extra = {}) => {
    const currentSnapshot = loadProductionSnapshot(options);
    writeSummary(currentSnapshot, options);
    writeWorkerReceipt(currentSnapshot, options, extra.stopReason ?? "status", extra.blocker);
    const next = selectNextMilestone(currentSnapshot.backlog, currentSnapshot.state);
    const rendererImpact = validateProductionRendererImpact({
      options,
      snapshot: currentSnapshot,
    });
    const rendererBlocked = !next && rendererImpact.status !== "pass";
    const status = currentSnapshot.state.blockedMilestone
      ? "blocked"
      : rendererBlocked
        ? "blocked"
        : next
          ? "ready"
          : "complete";
    const lock = readLock(currentSnapshot.paths);
    const state = {
      ...currentSnapshot.state,
      lastGlmPatchPath:
        currentSnapshot.state.lastGlmPatchPath ?? inferLastGlmPatchPath(currentSnapshot),
    };
    return {
      ok: (extra.ok ?? true) && !currentSnapshot.state.blockedMilestone && !rendererBlocked,
      status,
      blocker:
        extra.blocker ??
        currentSnapshot.state.blockedMilestone?.reason ??
        (rendererBlocked
          ? `production renderer impact failed: ${rendererImpact.failures.join("; ")}`
          : null),
      completedCount: currentSnapshot.state.completedMilestones?.length ?? 0,
      totalCount: currentSnapshot.backlog.milestones?.length ?? 0,
      currentMilestone: next,
      nextMilestone: next,
      rendererImpact,
      state,
      control: currentSnapshot.control,
      lock,
      paths: Object.fromEntries(
        Object.entries(currentSnapshot.paths).map(([key, value]) => [key, repoPath(value)]),
      ),
      policySummary: policySummary(currentSnapshot.policy),
      productionPolicy: currentSnapshot.policy,
      ...extra,
    };
  };

  if (options.mode === "status") {
    return statusReport({ ok: true });
  }
  if (options.mode === "pause") {
    updateControl(snapshot.paths, { paused: true, cancelRequested: false }, deps);
    appendDecision(snapshot.paths, { type: "pause", at: nowIso(deps) });
    return statusReport({ ok: true, status: "paused", stopReason: "pause requested" });
  }
  if (options.mode === "resume") {
    updateControl(snapshot.paths, { paused: false, cancelRequested: false }, deps);
    appendDecision(snapshot.paths, { type: "resume", at: nowIso(deps) });
    return statusReport({ ok: true, stopReason: "resume requested" });
  }
  if (options.mode === "cancel") {
    updateControl(snapshot.paths, { cancelRequested: true }, deps);
    appendDecision(snapshot.paths, { type: "cancel", at: nowIso(deps) });
    return statusReport({ ok: true, status: "cancelled", stopReason: "cancel requested" });
  }
  if (options.mode === "split-next") {
    const split = splitNextMilestone(options, snapshot, deps);
    snapshot = loadProductionSnapshot(options);
    writeSummary(snapshot, options);
    writeWorkerReceipt(snapshot, options, split.status);
    return {
      ...statusReport({ ok: true, stopReason: split.status }),
      split,
    };
  }
  if (options.mode === "retry-blocked" && snapshot.state.blockedMilestone) {
    appendDecision(snapshot.paths, {
      type: "retry-blocked",
      milestoneId: snapshot.state.blockedMilestone.id,
      at: nowIso(deps),
    });
    snapshot.state.blockedMilestone = null;
    writeJson(snapshot.paths.state, snapshot.state);
    snapshot = loadProductionSnapshot(options);
  }
  if (options.mode === "continue") {
    const next = selectNextMilestone(snapshot.backlog, snapshot.state, {
      retryBlocked: false,
    });
    if (isSplittableMilestone(next)) {
      splitNextMilestone(options, snapshot, deps);
      snapshot = loadProductionSnapshot(options);
    }
  }
  if (options.mode === "auto") {
    const lock = acquireWorkerLock(snapshot.paths, options, deps, snapshot.policy);
    if (!lock.acquired) {
      return {
        ...statusReport({ ok: false, stopReason: "lock-active", blocker: lock.blocker }),
        status: "blocked",
        blocker: lock.blocker,
      };
    }
    const startedAt = Date.now();
    const runtimeCapMs =
      Math.max(
        1,
        Number(options.maxRuntimeMinutes ?? snapshot.policy.defaultRuntimeCapMinutes ?? 30),
      ) * 60_000;
    const results = [];
    try {
      for (let index = 0; index < Math.max(0, options.maxMilestones ?? 40); index += 1) {
        heartbeatWorkerLock(snapshot.paths, deps);
        snapshot = loadProductionSnapshot(options);
        if (snapshot.control?.cancelRequested) {
          return {
            ...statusReport({ ok: true, stopReason: "cancel requested" }),
            status: "cancelled",
            results,
          };
        }
        if (snapshot.control?.paused) {
          return {
            ...statusReport({ ok: true, stopReason: "pause requested" }),
            status: "paused",
            results,
          };
        }
        if (Date.now() - startedAt >= runtimeCapMs) {
          return {
            ...statusReport({ ok: true, stopReason: "runtime cap reached" }),
            status: "runtime-cap",
            results,
          };
        }
        const next = selectNextMilestone(snapshot.backlog, snapshot.state);
        if (!next) break;
        if (isSplittableMilestone(next)) {
          results.push(splitNextMilestone(options, snapshot, deps));
          snapshot = loadProductionSnapshot(options);
        }
        const result = await runOneMilestone(options, snapshot, deps);
        results.push(result);
        snapshot = loadProductionSnapshot(options);
        if (
          result.status === "blocked" &&
          isSplittableMilestone(result.milestone, result.blocker)
        ) {
          results.push(splitNextMilestone(options, snapshot, deps));
          snapshot = loadProductionSnapshot(options);
          continue;
        }
        if (result.status !== "pass") break;
        if (!selectNextMilestone(snapshot.backlog, snapshot.state)) break;
      }
    } finally {
      releaseWorkerLock(snapshot.paths);
    }
    snapshot = loadProductionSnapshot(options);
    writeSummary(snapshot, options);
    writeWorkerReceipt(
      snapshot,
      options,
      snapshot.state.blockedMilestone ? "blocked" : "auto stopped",
      snapshot.state.blockedMilestone?.reason ?? null,
    );
    const next = selectNextMilestone(snapshot.backlog, snapshot.state);
    const state = {
      ...snapshot.state,
      lastGlmPatchPath: snapshot.state.lastGlmPatchPath ?? inferLastGlmPatchPath(snapshot),
    };
    return {
      ok: !snapshot.state.blockedMilestone,
      status: snapshot.state.blockedMilestone ? "blocked" : next ? "ready" : "complete",
      completedCount: snapshot.state.completedMilestones?.length ?? 0,
      totalCount: snapshot.backlog.milestones?.length ?? 0,
      currentMilestone: next,
      nextMilestone: next,
      results,
      state,
      control: snapshot.control,
      paths: Object.fromEntries(
        Object.entries(snapshot.paths).map(([key, value]) => [key, repoPath(value)]),
      ),
      policySummary: policySummary(snapshot.policy),
      productionPolicy: snapshot.policy,
    };
  }
  const results = [];
  for (let index = 0; index < Math.max(0, options.maxMilestones ?? 1); index += 1) {
    const result = await runOneMilestone(options, snapshot, deps);
    results.push(result);
    snapshot = loadProductionSnapshot(options);
    if (result.status !== "pass") break;
    if (!selectNextMilestone(snapshot.backlog, snapshot.state)) break;
  }
  writeSummary(snapshot, options);
  writeWorkerReceipt(
    snapshot,
    options,
    snapshot.state.blockedMilestone ? "blocked" : "continue stopped",
    snapshot.state.blockedMilestone?.reason ?? null,
  );
  const next = selectNextMilestone(snapshot.backlog, snapshot.state);
  const state = {
    ...snapshot.state,
    lastGlmPatchPath: snapshot.state.lastGlmPatchPath ?? inferLastGlmPatchPath(snapshot),
  };
  return {
    ok: results.every((result) => result.status === "pass") && !snapshot.state.blockedMilestone,
    status: snapshot.state.blockedMilestone ? "blocked" : next ? "ready" : "complete",
    completedCount: snapshot.state.completedMilestones?.length ?? 0,
    totalCount: snapshot.backlog.milestones?.length ?? 0,
    nextMilestone: next,
    results,
    state,
    control: snapshot.control,
    paths: Object.fromEntries(
      Object.entries(snapshot.paths).map(([key, value]) => [key, repoPath(value)]),
    ),
    policySummary: policySummary(snapshot.policy),
    productionPolicy: snapshot.policy,
  };
}

export function productionSucceeded(report) {
  return (
    report?.ok === true ||
    report?.status === "ready" ||
    report?.status === "complete" ||
    report?.status === "paused" ||
    report?.status === "cancelled" ||
    report?.status === "runtime-cap"
  );
}
