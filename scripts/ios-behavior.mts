#!/usr/bin/env node
// Measures chat UX on the iOS simulator against an isolated Gateway whose model is the scripted
// QA mock: streaming follow, reading position while scrolled up, keyboard, relaunch, and a blank
// transcript judged from screenshots (keyboard, chat length and agent turns, chat switches).
// Usage: pnpm ios:behavior [--setup] [--profile ios-ux] [--cases a,b] [--samples 3] [--app <app>]
// --setup writes the profile (Gateway stopped): loopback port, token auth, mock model.
// Then run the mock and the Gateway (see .agents/skills/ios-e2e/BEHAVIOR.md) and this script.
// IOS_SIM reuses a paired simulator; otherwise a fresh one is paired and deleted afterwards.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  type ProbeFrame,
  type ProbeLog,
  type Rect,
  type ScreenLine,
  bodyCounts,
  composerGap,
  hiddenBelowComposer,
  firstEvent,
  firstFrame,
  lastFrameBefore,
  motion,
  parseProbeLog,
  percentile,
  remounts,
  transcriptText,
  window,
} from "./lib/ios-behavior-grade.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const { values } = parseArgs({
  options: {
    setup: { type: "boolean", default: false },
    profile: { type: "string", default: "ios-ux" },
    port: { type: "string", default: "19061" },
    "mock-url": { type: "string", default: "http://127.0.0.1:44180/v1" },
    cases: {
      type: "string",
      default: [
        "stream-turn",
        "stream-follow",
        "scrolled-up",
        "keyboard",
        "relaunch",
        "switch-session",
        ...["up", "down"].flatMap((keyboard) =>
          ["short", "long"].flatMap((length) =>
            ["plain", "agent"].map((content) => `blank-${keyboard}-${length}-${content}`),
          ),
        ),
      ].join(","),
    },
    samples: { type: "string", default: "3" },
    out: { type: "string" },
    // Existing chats (session keys, `agent:main:` omitted) for the cases that need history, in
    // place of seeding mock turns: point --profile at a scratch copy of a real profile to judge
    // real transcripts. Never commit such profiles or their screenshots.
    sessions: { type: "string" },
    app: {
      type: "string",
      default: path.join(
        repoRoot,
        "apps/ios/build/DerivedData/Build/Products/Debug-iphonesimulator/OpenClaw.app",
      ),
    },
  },
});
const profile = values.profile;
const END_MARKER = "UX-STREAM-END";
const MOCK_MODEL = "mock-openai/gpt-5.6-luna";
// Prompts for the blank-transcript cases. The defaults drive the QA mock; `UXAGENT` is an agent
// turn (commentary, tool calls, progress card, then a long reply). A profile with a real model
// passes its own prompts through these variables.
const SEED_PROMPT = process.env.IOS_BEHAVIOR_SEED_PROMPT ?? "UXSTREAM chunks=150 interval=0";
const REPLY_PROMPT = process.env.IOS_BEHAVIOR_REPLY_PROMPT ?? "UXSTREAM chunks=300 interval=20";
const SHORT_PROMPT = process.env.IOS_BEHAVIOR_SHORT_PROMPT ?? "UXSTREAM chunks=4 interval=0";
const AGENT_SEED_PROMPT =
  process.env.IOS_BEHAVIOR_AGENT_SEED_PROMPT ?? "UXAGENT steps=4 chunks=150 interval=0";
const AGENT_REPLY_PROMPT =
  process.env.IOS_BEHAVIOR_AGENT_REPLY_PROMPT ?? "UXAGENT steps=4 chunks=300 interval=20";
const replaySessions = values.sessions
  ?.split(",")
  .map((key) => key.trim())
  .filter(Boolean);
if (replaySessions && replaySessions.length < 2) {
  console.error("ios:behavior: --sessions needs at least two chats.");
  process.exit(1);
}
let replayIndex = 0;

// Set once this run creates a simulator, so every exit path deletes it.
const owned: { simulator?: string; recorder?: ChildProcess } = {};

function deleteOwnedSimulator() {
  if (owned.simulator) {
    spawnSync("xcrun", ["simctl", "delete", owned.simulator]);
    owned.simulator = undefined;
  }
}

function fail(message: string): never {
  // simctl finishes the file on SIGINT by itself; without it, recording outlives the runner.
  owned.recorder?.kill("SIGINT");
  deleteOwnedSimulator();
  console.error(`ios:behavior: ${message}`);
  process.exit(1);
}

function run(command: string, args: string[], options: { allowFailure?: boolean } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    fail(`${command} ${args.slice(0, 3).join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

const openclaw = (args: string[]) =>
  run("node", ["openclaw.mjs", "--profile", profile, ...args]).stdout.trim();

if (values.setup) {
  // The token stays out of argv: the batch goes through a private temp file.
  const dir = mkdtempSync(path.join(tmpdir(), "ios-behavior-"));
  try {
    const batch = path.join(dir, "config.json");
    writeFileSync(
      batch,
      JSON.stringify([
        { path: "gateway.mode", value: "local" },
        { path: "gateway.port", value: Number(values.port) },
        { path: "gateway.auth.mode", value: "token" },
        { path: "gateway.auth.token", value: randomBytes(24).toString("hex") },
        { path: "models.mode", value: "replace" },
        {
          path: "models.providers.mock-openai",
          value: {
            baseUrl: values["mock-url"],
            apiKey: "test",
            api: "openai-responses",
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: "gpt-5.6-luna",
                name: "gpt-5.6-luna",
                api: "openai-responses",
                compat: { sendSessionIdHeader: true },
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4096,
              },
            ],
          },
        },
        { path: "agents.defaults.model", value: { primary: MOCK_MODEL } },
        {
          path: "agents.defaults.models",
          value: { [MOCK_MODEL]: { params: { transport: "sse", openaiWsWarmup: false } } },
        },
      ]),
      { mode: 0o600 },
    );
    openclaw(["config", "set", "--batch-file", batch]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`ios:behavior: profile ${profile} uses ${MOCK_MODEL} on port ${values.port}`);
  process.exit(0);
}

if (!existsSync(values.app)) {
  fail(`no app at ${values.app}. Build it first (mobilebuildmcp simulator build) or pass --app.`);
}
const bundleId = run("/usr/libexec/PlistBuddy", [
  "-c",
  "Print :CFBundleIdentifier",
  path.join(values.app, "Info.plist"),
]).stdout.trim();
const samples = Number(values.samples);
const caseNames = values.cases.split(",").map((name) => name.trim());
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(values.out ?? path.join(repoRoot, ".artifacts/ios-behavior", stamp));
mkdirSync(outDir, { recursive: true });

let sim = process.env.IOS_SIM ?? "";
if (sim) {
  run("xcrun", ["simctl", "install", sim, values.app]);
} else {
  sim = run("xcrun", [
    "simctl",
    "create",
    `openclaw-behavior-${Date.now()}`,
    "iPhone 17",
  ]).stdout.trim();
  owned.simulator = sim;
  const paired = spawnSync(
    "node",
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/ios-sim-pair.mts",
      "--profile",
      profile,
      "--app",
      values.app,
    ],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, IOS_SIM: sim } },
  );
  if (paired.status !== 0) {
    fail(`pairing failed:\n${paired.stderr || paired.stdout}`);
  }
}

// UI drivers type through hardware key events, after which iOS records a hardware keyboard and
// never shows the software one, so the app's keyboard-up layout cannot be measured. Clear that
// record while the simulator is off; cases then enter text by pasting, never by typing.
run("xcrun", ["simctl", "shutdown", sim], { allowFailure: true });
const keyboardPrefs = path.join(
  homedir(),
  "Library/Developer/CoreSimulator/Devices",
  sim,
  "data/Library/Preferences/com.apple.keyboard.preferences.plist",
);
for (const key of ["HardwareKeyboardLastSeen", "AutomaticMinimizationEnabled"]) {
  run("plutil", ["-replace", key, "-bool", "NO", keyboardPrefs]);
}
run("xcrun", ["simctl", "boot", sim]);
run("xcrun", ["simctl", "bootstatus", sim, "-b"]);
// bootstatus returns before app launches are accepted; the first launches can fail. On a loaded
// Mac that took longer than the old 20 s, so wait by time and report the last error.
const launchDeadline = Date.now() + 90_000;
for (;;) {
  const launched = spawnSync("xcrun", ["simctl", "launch", sim, bundleId], { encoding: "utf8" });
  if (launched.status === 0) {
    break;
  }
  if (Date.now() > launchDeadline) {
    fail(`the app would not launch on the rebooted simulator:\n${launched.stderr}`);
  }
  await delay(2000);
}

const axe = path.join(
  run("brew", ["--prefix", "mobilebuildmcp"]).stdout.trim(),
  "libexec/bundled/axe",
);

const ui = (args: string[], options: { allowFailure?: boolean } = {}) =>
  run("mobilebuildmcp", ["ui-automation", ...args, "--simulator-id", sim], options);
function ref(pattern: RegExp): string {
  const rows = ui(["snapshot-ui", "--style", "minimal"]).stdout.split("\n");
  const row = rows.findLast((line) => pattern.test(line));
  return row?.split("|")[0]?.trim() || fail(`no element matches ${pattern} on screen.`);
}
const tap = (pattern: RegExp) => ui(["tap", "--element-ref", ref(pattern)]);

type AxNode = {
  AXLabel?: string;
  AXUniqueId?: string;
  frame?: { x: number; y: number; width: number; height: number };
  children?: AxNode[];
};
// Elements outside the app's own tree (the edit menu) and plain scroll views only show up in
// AXe's tree, with frames in points.
function axFrame(match: (node: AxNode) => boolean) {
  const roots = JSON.parse(run(axe, ["describe-ui", "--udid", sim]).stdout) as AxNode[];
  let found: AxNode["frame"];
  const walk = (node: AxNode) => {
    if (match(node) && node.frame && (!found || node.frame.height > found.height)) {
      found = node.frame;
    }
    node.children?.forEach(walk);
  };
  roots.forEach(walk);
  return found;
}
function tapAt(x: number, y: number) {
  run(axe, ["tap", "-x", String(Math.round(x)), "-y", String(Math.round(y)), "--udid", sim]);
}
const keyboardShown = () => ui(["snapshot-ui", "--style", "minimal"]).stdout.includes("|space|");

// Paste through the edit menu: leaves the software keyboard up and the text exact.
async function enterText(text: string) {
  spawnSync("xcrun", ["simctl", "pbcopy", sim], { input: text });
  ui(["long-press", "--element-ref", ref(/chat-message-input/), "--duration", "900"]);
  await delay(800);
  const paste = axFrame((node) => node.AXLabel === "Paste") ?? fail("the edit menu has no Paste.");
  tapAt(paste.x + paste.width / 2, paste.y + paste.height / 2);
  await delay(500);
}

// The transcript's tap gesture resigns the composer. Tap low in the transcript: starter cards
// fill the top of an empty chat, and tapping one sends it.
async function hideKeyboard() {
  const transcript =
    axFrame((node) => node.AXUniqueId === "chat-transcript") ??
    fail("no chat transcript on screen.");
  tapAt(transcript.x + transcript.width / 2, transcript.y + transcript.height * 0.85);
  await delay(1000);
}

// The MobileBuildMCP daemon ends any request after 30 s, so long waits repeat a 25 s wait.
async function waitForText(text: string, totalMs: number) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const waited = ui(
      ["wait-for-ui", "--predicate", "textContains", "--text", text, "--timeout-ms", "25000"],
      { allowFailure: true },
    );
    if (waited.ok) {
      return;
    }
    await delay(250);
  }
  const screenshot = path.join(outDir, "timeout.png");
  run("xcrun", ["simctl", "io", sim, "screenshot", screenshot], { allowFailure: true });
  fail(`"${text}" did not appear within ${totalMs} ms; screen: ${screenshot}`);
}

function launch(session: string) {
  const startedAt = Date.now();
  run("xcrun", [
    "simctl",
    "launch",
    "--terminate-running-process",
    sim,
    bundleId,
    "--openclaw-behavior-probe",
    "--openclaw-chat-session",
    session,
    "-AppleLanguages",
    "(en)",
    "-AppleLocale",
    "en_US",
  ]);
  ui([
    "wait-for-ui",
    "--predicate",
    "exists",
    "--identifier",
    "chat-message-input",
    "--timeout-ms",
    "25000",
  ]);
  return startedAt;
}

async function send(prompt: string) {
  await enterText(prompt);
  tap(/chat-send-message/);
}

async function readProbe(file: string): Promise<ProbeLog> {
  // The probe flushes every 250 ms.
  await delay(600);
  const container = run("xcrun", [
    "simctl",
    "get_app_container",
    sim,
    bundleId,
    "data",
  ]).stdout.trim();
  const text = readFileSync(path.join(container, "Library/Caches/behavior-probe.jsonl"), "utf8");
  writeFileSync(file, text);
  return parseProbeLog(text);
}

/** A chat with history: the next --sessions chat, or `session` after a seeded mock turn. */
async function longChat(session: string, seedPrompt: string) {
  if (replaySessions) {
    replayIndex += 1;
    return replaySessions[replayIndex % replaySessions.length] ?? session;
  }
  await agentTurn(session, seedPrompt);
  return session;
}

function runAsync(command: string, args: string[]) {
  return new Promise<string>((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => fail(`${command} failed: ${error.message}`));
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : fail(`${command} ${args.slice(0, 3).join(" ")} failed:\n${stderr || stdout}`),
    );
  });
}

// One agent turn in `session` through the Gateway CLI; settles when the run finishes. Seeds chat
// history without driving the app, so turns for several chats can run at once.
const agentTurn = (session: string, message: string) =>
  runAsync("node", [
    "openclaw.mjs",
    "--profile",
    profile,
    "agent",
    "--agent",
    "main",
    "--session-key",
    `agent:main:${session}`,
    "--message",
    message,
    "--json",
  ]);

// Screen oracle. Each sample is a screenshot plus the accessibility geometry nearest in time
// (where the transcript and composer are, and the chrome to ignore); text recognition runs over a
// batch of screenshots afterwards. The view tree and accessibility both kept listing content while
// a real iPhone showed a blank chat (#191478); recognized pixels do not.
type ScreenSample = {
  png: string;
  screen: { width: number; height: number };
  transcript?: Rect;
  exclude: Rect[];
  /** A progress card was on screen: the agent fixture's tool steps really ran. */
  progressCard: boolean;
};
let screenCount = 0;
const screensDir = path.join(outDir, "screens");
mkdirSync(screensDir, { recursive: true });

// Compiled once per run: the Vision CLI takes ~0.2 s per screenshot in batch; the motion CLI reads
// every native frame of a recording window (~4 s for a 12 s window).
const screenTextTool = path.join(outDir, "ios-screen-text");
const screenMotionTool = path.join(outDir, "ios-screen-motion");
for (const [tool, source] of [
  [screenTextTool, "ios-screen-text.swift"],
  [screenMotionTool, "ios-screen-motion.swift"],
] as const) {
  run("xcrun", ["swiftc", "-O", "-o", tool, path.join(repoRoot, "scripts", source)]);
}

type Layout = Omit<ScreenSample, "png">;

function readLayout(roots: AxNode[]): Layout {
  let transcript: Rect | undefined;
  let composerTop = Infinity;
  const exclude: Rect[] = [];
  let progressCard = false;
  const walk = (node: AxNode) => {
    const id = node.AXUniqueId ?? "";
    const text = node.AXLabel ?? "";
    if (node.frame) {
      if (id === "chat-transcript" && (!transcript || node.frame.height > transcript.height)) {
        transcript = node.frame;
      }
      if (id === "chat-composer-surface" || id === "chat-message-input") {
        composerTop = Math.min(composerTop, node.frame.y);
      }
      // Chrome that stays drawn while the messages are gone: the progress card and run footer.
      if (id.startsWith("chat-progress-card") || /^(Plan, |Done in )/.test(text)) {
        exclude.push(node.frame);
      }
      progressCard ||= id.startsWith("chat-progress-card");
    }
    node.children?.forEach(walk);
  };
  roots.forEach(walk);
  const screen = roots[0]?.frame ?? { width: 0, height: 0 };
  if (transcript) {
    const bottom = Math.min(transcript.y + transcript.height, composerTop);
    transcript = { ...transcript, height: Math.max(0, bottom - transcript.y) };
  }
  return { screen, transcript, exclude, progressCard };
}

/**
 * Screenshots back to back for `ms`, each paired with the accessibility read nearest in time. A
 * screenshot takes ~0.4 s and `describe-ui` ~1.9 s, so the reads run in their own loop: one read
 * per screenshot left 2.5-6 s between samples, enough to miss a blank users see. The rects only
 * move with the keyboard, navigation or a progress card; a read ~1 s off the screenshot is
 * accepted.
 */
async function watchScreen(label: string, ms: number): Promise<ScreenSample[]> {
  const until = Date.now() + ms;
  const timed = async <T,>(work: Promise<T>) => {
    const start = Date.now();
    const value = await work;
    return { t: (start + Date.now()) / 2, value };
  };
  const layouts: { t: number; layout: Layout }[] = [];
  const shots: { t: number; png: string }[] = [];
  await Promise.all([
    (async () => {
      do {
        const { t, value } = await timed(runAsync(axe, ["describe-ui", "--udid", sim]));
        layouts.push({ t, layout: readLayout(JSON.parse(value) as AxNode[]) });
      } while (Date.now() < until);
    })(),
    (async () => {
      do {
        screenCount += 1;
        const png = path.join(screensDir, `${String(screenCount).padStart(4, "0")}-${label}.png`);
        const { t } = await timed(runAsync("xcrun", ["simctl", "io", sim, "screenshot", png]));
        shots.push({ t, png });
      } while (Date.now() < until);
    })(),
  ]);
  return shots.map(({ t, png }) => {
    const { layout } = layouts.reduce((best, entry) =>
      Math.abs(entry.t - t) < Math.abs(best.t - t) ? entry : best,
    );
    const { screen, transcript, exclude, progressCard } = layout;
    return { png, screen, transcript, exclude, progressCard };
  });
}

type ScreenRead = { png: string; lines: number };

/**
 * Lines of transcript text per sample, grouped like `windows` (one `watchScreen` call each); -1
 * where no transcript was on screen to judge.
 */
function readScreens(windows: ScreenSample[][]): ScreenRead[][] {
  const watched = windows.flat();
  const lines = new Map<string, ScreenLine[]>();
  for (let start = 0; start < watched.length; start += 50) {
    const batch = watched.slice(start, start + 50).map((entry) => entry.png);
    for (const record of run(screenTextTool, batch).stdout.trim().split("\n")) {
      if (record) {
        const parsed = JSON.parse(record) as { image: string; lines: ScreenLine[] };
        lines.set(parsed.image, parsed.lines);
      }
    }
  }
  return windows.map((shots) =>
    shots.map((entry) => ({
      png: entry.png,
      lines: entry.transcript
        ? transcriptText(lines.get(entry.png) ?? [], entry.screen, entry.transcript, entry.exclude)
            .length
        : -1,
    })),
  );
}

function screenGates(windows: ScreenRead[][], when: string): Result {
  const reads = windows.flat();
  const judged = reads.filter((entry) => entry.lines >= 0);
  const blank = judged.filter((entry) => entry.lines === 0);
  for (const entry of blank) {
    console.log(`ios:behavior: blank transcript on screen: ${entry.png}`);
  }
  for (const entry of reads.filter((read) => read.lines < 0)) {
    console.log(`ios:behavior: no transcript to judge: ${entry.png}`);
  }
  return {
    metrics: {
      screenSamples: judged.length,
      blankSamples: blank.length,
      unjudgedSamples: reads.length - judged.length,
      minTextLines: judged.length > 0 ? Math.min(...judged.map((entry) => entry.lines)) : undefined,
    },
    gates: {
      // Every sample: a transcript that vanished from the screen, then came back, must not pass
      // because the samples around it could be judged.
      [`transcript on screen to judge ${when} (setup)`]:
        reads.length >= 3 && judged.length === reads.length,
      [`transcript text on screen ${when}`]: blank.length === 0,
    },
  };
}

type Metrics = Record<string, number | undefined>;
/**
 * `drawnMotion`: windows (epoch ms) and screen areas (points) to measure on the case's recording
 * once it is written; `ignoreX` is a column range holding a control that moves by design.
 */
type DrawnWindow = {
  from: number;
  to: number;
  area: Rect;
  screenWidth: number;
  ignoreX?: [number, number];
};
type Result = {
  metrics: Metrics;
  gates: Record<string, boolean>;
  drawnMotion?: DrawnWindow[];
};
// `guard`: every gate passes in every sample. `bad`: reproduces an open bug, so its setup gates
// pass and another gate fails in at least one sample; once the fix lands every gate passes and
// the case becomes a guard. No majority vote: a jump in one sample is a jump users see.
type Case = { kind: "guard" | "bad"; run: (session: string, file: string) => Promise<Result> };

const isSetupGate = (gate: string) => gate.endsWith("(setup)");

function verdict(kind: Case["kind"], passes: Record<string, number>, sampleCount: number) {
  const entries = Object.entries(passes);
  if (entries.some(([gate, count]) => isSetupGate(gate) && count < sampleCount)) {
    return "setup failed";
  }
  const allPass = entries.every(([, count]) => count === sampleCount);
  if (kind === "guard") {
    return allPass ? "ok" : "regressed";
  }
  return allPass ? "bug fixed: make it a guard" : "ok (known bug)";
}

const sendTime = (log: ProbeLog) =>
  firstEvent(log.events, (event) => event.e === "mark" && event.k === "send") ??
  fail("the probe recorded no send; is this a DEBUG build with the probe?");

// A long reply streams in after a send. The app has two reading policies (ChatView
// handleTimelineChange): with the keyboard hidden it pins the sent message near the top and lets
// the reply grow below it; with the keyboard up it follows the live edge (#108692).
function streamCase(keyboardUp: boolean): Case {
  return {
    kind: "guard",
    async run(session, file) {
      launch(session);
      await enterText("UXSTREAM chunks=300 interval=40");
      if (!keyboardUp) {
        await hideKeyboard();
      }
      const keyboardAtSend = keyboardShown();
      tap(/chat-send-message/);
      // The turn recap sits above the composer, so it shows even when the transcript ends up
      // scrolled away from the reply (a bug this case records rather than aborts on).
      await waitForText("Done in", 90_000);
      await delay(2000);
      const end = Date.now();
      const log = await readProbe(file);
      const sentAt = sendTime(log);
      const view = window(log, sentAt, end);
      const mountOf = (prefix: string) =>
        view.events.find((e) => e.e === "mount" && e.k?.startsWith(prefix) === true);
      const finalKey = mountOf("assistant/")?.k;
      const aliases = finalKey ? { [finalKey]: "live" } : {};
      const finalAt = mountOf("assistant/")?.t;
      const moved = motion(view.frames, { aliases });
      const userMount = mountOf("user/");
      const firstText = firstFrame(view.frames, (frame) => "live" in frame.f);
      const bodies = bodyCounts(view.events);
      // Only the composer is tagged in every frame; read the end against its last position.
      const last = view.frames.findLast((frame) => "composer" in frame.f);
      const common: Metrics = {
        sendToBubbleMs: userMount && userMount.t - sentAt,
        sendToFirstTextMs: firstText && firstText - sentAt,
        teleports: moved.teleports,
        remounts: remounts(log.events, sentAt, end),
        liveBodies: bodies.live ?? 0,
        bubbleBodies: bodies.bubble ?? 0,
      };
      const setup = {
        [`keyboard ${keyboardUp ? "up" : "hidden"} at send (setup)`]: keyboardAtSend === keyboardUp,
      };
      if (keyboardUp) {
        const streaming = view.frames.filter(
          (frame) => firstText !== undefined && frame.t >= firstText && frame.t < (finalAt ?? end),
        );
        const followLag = percentile(
          streaming.map((frame) => hiddenBelowComposer(frame) ?? 0),
          0.95,
        );
        const hidden = hiddenBelowComposer(last);
        // Teleports and backward motion are reported, not gated: in about one run in ten the
        // transcript still flashes to the top for ~80 ms as the final row replaces the live bubble,
        // and the reply's end dips ~40 pt for a frame as the working indicator leaves.
        return {
          metrics: {
            ...common,
            backwardPt: moved.backwardPt,
            followLagP95Pt: followLag,
            hiddenAtEndPt: hidden,
          },
          gates: {
            ...setup,
            "reply followed while streaming (p95 ≤4 pt hidden)": (followLag ?? Infinity) <= 4,
            "end in view after it finishes (≤4 pt hidden)": (hidden ?? Infinity) <= 4,
            "no remounts": common.remounts === 0,
          },
        };
      }
      // The one-shot move to the new turn lands within a second; after that the pin must hold. The
      // gate reads the recording: on the `List` transcript (#192232) the probe also reports cell
      // layouts of 5–60 pt that never reach the screen, so its drift is reported only. Two drawn
      // windows cover it. While the reply grows, its footer row moves down, which the recording
      // cannot tell from a scroll, so the early window's area ends above the footer's first
      // position (it only moves down from there). It opens once that area holds two strips,
      // ~150–400 ms after the first second. From when the reply fills the screen, the late window
      // covers the whole transcript above the run footer, which appears when the reply ends,
      // minus the columns of the jump-to-latest button, which floats over the reply.
      const pinned = motion(window(log, sentAt + 1000, end).frames, { aliases });
      const userKey = userMount?.k;
      const replyHidden = hiddenBelowComposer(last) ?? 0;
      const layout = readLayout(
        JSON.parse(run(axe, ["describe-ui", "--udid", sim]).stdout) as AxNode[],
      );
      const transcript = layout.transcript ?? fail("no transcript on screen after the reply.");
      const filled = firstFrame(
        view.frames,
        (frame) => (frame.f.live?.[1] ?? 0) > (frame.f.composer?.[0] ?? Infinity),
      );
      // Bottom of the reply's footer row: avatar and elapsed time, 44 pt tall.
      const footerTop = (frame: ProbeFrame) => (frame.f.live?.[1] ?? 0) - 44;
      const early = view.frames.find(
        (frame) => frame.t >= sentAt + 1000 && footerTop(frame) - transcript.y >= 80,
      );
      const bottom = Math.min(
        transcript.y + transcript.height,
        ...layout.exclude.filter((rect) => rect.y > transcript.y).map((rect) => rect.y),
      );
      const jump = axFrame((node) => node.AXLabel === "Jump to latest reply");
      return {
        metrics: {
          ...common,
          pinnedTopPt: userKey ? last?.f[userKey]?.[0] : undefined,
          rowDriftPt: pinned.maxDriftPt,
          replyBelowFoldPt: replyHidden,
        },
        gates: {
          ...setup,
          "reply grew past the fold (setup)":
            replyHidden > 100 && filled !== undefined && early !== undefined,
          "no teleports": moved.teleports === 0,
          "no remounts": common.remounts === 0,
        },
        drawnMotion: [
          {
            from: early?.t ?? end,
            // Past the late window's start: each window measures from its own first frame, so a
            // jump right at the boundary would be the late window's baseline.
            to: filled === undefined ? end : filled + 500,
            area: { ...transcript, height: early ? footerTop(early) - transcript.y : 0 },
            screenWidth: layout.screen.width,
          },
          {
            from: filled ?? end,
            to: end,
            area: { ...transcript, height: bottom - transcript.y },
            screenWidth: layout.screen.width,
            ignoreX: jump && [jump.x, jump.x + jump.width],
          },
        ],
      };
    },
  };
}

const cases: Record<string, Case> = {
  "stream-turn": streamCase(false),
  "stream-follow": streamCase(true),
  // Scrolled up while a reply streams below: what the reader sees must not move.
  "scrolled-up": {
    kind: "guard",
    async run(session, file) {
      launch(session);
      await send("UXSTREAM chunks=150 interval=0");
      await waitForText(END_MARKER, 60_000);
      // 80 s of streaming: still running when the hold ends, so the hold sees only growth below.
      await send("UXSTREAM chunks=2000 interval=40");
      await delay(2000);
      // An interactive swipe would also dismiss the keyboard and move every row; settle it first.
      await hideKeyboard();
      // By coordinates inside the transcript's frame: the iOS transcript is a `List`, which the
      // UI driver does not offer as a scroll container (#192232).
      const area =
        axFrame((node) => node.AXUniqueId === "chat-transcript") ?? fail("no transcript.");
      const x = String(Math.round(area.x + area.width / 2));
      run(axe, [
        "swipe",
        "--start-x",
        x,
        "--start-y",
        String(Math.round(area.y + area.height * 0.25)),
        "--end-x",
        x,
        "--end-y",
        String(Math.round(area.y + area.height * 0.75)),
        "--duration",
        "0.3",
        "--udid",
        sim,
      ]);
      await delay(1500);
      const holdFrom = Date.now();
      await delay(5000);
      const holdTo = Date.now();
      const log = await readProbe(file);
      const view = window(log, holdFrom, holdTo);
      const moved = motion(view.frames);
      const away = hiddenBelowComposer(lastFrameBefore(log.frames, holdFrom));
      const rebuilt = remounts(log.events, holdFrom, holdTo);
      return {
        metrics: {
          scrolledAwayPt: away,
          readingDriftPt: moved.maxDriftPt,
          teleports: moved.teleports,
          remounts: rebuilt,
        },
        gates: {
          "scrolled away from the end (setup)": (away ?? 0) > 100,
          "reading position holds (≤1 pt)": moved.maxDriftPt <= 1,
          "no remounts": rebuilt === 0,
        },
      };
    },
  },
  // Keyboard up and down at the end of a transcript: no gap opens above the composer.
  keyboard: {
    kind: "guard",
    async run(session, file) {
      launch(session);
      await send("UXSTREAM chunks=150 interval=0");
      await waitForText(END_MARKER, 60_000);
      await hideKeyboard();
      const before = Date.now();
      tap(/chat-message-input/);
      await delay(1500);
      const opened = Date.now();
      await hideKeyboard();
      const after = Date.now();
      const log = await readProbe(file);
      const at = (t: number) => lastFrameBefore(log.frames, t);
      const gapBefore = composerGap(at(before));
      const gapOpen = composerGap(at(opened));
      const gapAfter = composerGap(at(after));
      const lift = (at(before)?.f.composer?.[0] ?? 0) - (at(opened)?.f.composer?.[0] ?? 0);
      const moved = motion(window(log, before, after).frames);
      const steady = (gap: number | undefined) =>
        gap !== undefined && gapBefore !== undefined && Math.abs(gap - gapBefore) <= 1;
      return {
        metrics: {
          keyboardLiftPt: Math.round(lift),
          gapBeforePt: gapBefore,
          gapOpenPt: gapOpen,
          gapAfterPt: gapAfter,
          teleports: moved.teleports,
        },
        gates: {
          "software keyboard shown (setup)": lift > 100,
          "gap steady with keyboard up (≤1 pt)": steady(gapOpen),
          "gap steady after dismiss (≤1 pt)": steady(gapAfter),
          "no teleports": moved.teleports === 0,
        },
      };
    },
  },
  // Cold relaunch into a session with history, three times per sample. Teleports are reported,
  // not gated: on main the first frame sometimes shows the top of history and then jumps to the
  // end, but too rarely (3 of 9 launches) for a gate that does not flake.
  relaunch: {
    kind: "guard",
    async run(session, file) {
      launch(session);
      await send("UXSTREAM chunks=150 interval=0");
      await waitForText(END_MARKER, 60_000);
      const launches = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const startedAt = launch(session);
        await delay(3000);
        const end = Date.now();
        const view = window(
          await readProbe(file.replace(/\.jsonl$/, `-${attempt}.jsonl`)),
          startedAt,
          end,
        );
        const rowsAt = firstFrame(view.frames, (frame) =>
          Object.keys(frame.f).some((key) => key.includes("/")),
        );
        const moved = motion(
          view.frames.filter((frame) => rowsAt !== undefined && frame.t >= rowsAt),
        );
        launches.push({
          composerMs: firstFrame(view.frames, (frame) => "composer" in frame.f),
          rowsMs: rowsAt && rowsAt - startedAt,
          startedAt,
          moved,
          hidden: hiddenBelowComposer(view.frames.at(-1)),
        });
      }
      const teleports = launches.reduce((sum, entry) => sum + entry.moved.teleports, 0);
      return {
        metrics: {
          launchToComposerMs: percentile(
            launches.flatMap((entry) =>
              entry.composerMs ? [entry.composerMs - entry.startedAt] : [],
            ),
            0.5,
          ),
          launchToRowsMs: percentile(
            launches.flatMap((entry) => (entry.rowsMs ? [entry.rowsMs] : [])),
            0.5,
          ),
          shiftAfterFirstRowsPt: Math.max(...launches.map((entry) => entry.moved.maxDriftPt)),
          teleports,
        },
        gates: {
          "opens at the end (≤4 pt hidden)": launches.every(
            (entry) => (entry.hidden ?? Infinity) <= 4,
          ),
        },
      };
    },
  },
  // Opening an existing chat from the sidebar (#191478, trigger A): the transcript shows text in
  // every screen sample after the switch, without a swipe. Switches go between long agent chats
  // and a short one, as in the report.
  "switch-session": {
    kind: "guard",
    async run(session) {
      const short = `${session}-short`;
      const long = replaySessions?.[0] ?? `${session}-long`;
      const long2 = replaySessions?.[1] ?? `${session}-long2`;
      await Promise.all([
        ...(replaySessions
          ? []
          : [agentTurn(long, AGENT_SEED_PROMPT), agentTurn(long2, AGENT_SEED_PROMPT)]),
        agentTurn(short, SHORT_PROMPT).then(() => agentTurn(short, SHORT_PROMPT)),
      ]);
      const chats = [long, short, long2] as const;
      launch(long);
      await delay(3000);
      const watched: ScreenSample[][] = [];
      for (const chat of [chats[1], chats[0], chats[1], chats[2], chats[0], chats[2]]) {
        tap(/RootTabs\.Sidebar\.Show/);
        await delay(800);
        tap(new RegExp(`\\|${chat.replace(/-/g, "\\-")}, `));
        watched.push(await watchScreen(`switch-${chat}`, 3000));
      }
      return screenGates(readScreens(watched), "after every switch");
    },
  },
  ...blankMatrix(),
};

// Every combination of keyboard up/down, short/long chat and plain/agent content, each judged by
// the screen oracle from composer focus until after the reply ends. The harness missed #191478
// because its only keyboard-up sends were in short plain chats; `blank-up-long-agent` is that bug.
function blankMatrix(): Record<string, Case> {
  const matrix: Record<string, Case> = {};
  for (const keyboard of ["up", "down"] as const) {
    for (const length of ["short", "long"] as const) {
      for (const content of ["plain", "agent"] as const) {
        matrix[`blank-${keyboard}-${length}-${content}`] = {
          kind: "guard",
          async run(session) {
            const prompt = content === "agent" ? AGENT_REPLY_PROMPT : REPLY_PROMPT;
            const chat =
              length === "long"
                ? await longChat(session, content === "agent" ? AGENT_SEED_PROMPT : SEED_PROMPT)
                : session;
            launch(chat);
            await delay(2000);
            await enterText(prompt);
            if (keyboard === "down") {
              await hideKeyboard();
            }
            const keyboardAtSend = keyboardShown();
            const focused = await watchScreen("focus", 3000);
            tap(/chat-send-message/);
            const sent: ScreenSample[][] = [];
            const until = Date.now() + 90_000;
            let replied = false;
            while (!replied && Date.now() < until) {
              sent.push(await watchScreen("send", 2000));
              // The run footer is static text, which the snapshot's target list leaves out. The
              // app shows it only for a run it watched from its own send.
              replied =
                axFrame((node) => node.AXLabel?.startsWith("Done in") ?? false) !== undefined;
            }
            if (replied) {
              sent.push(await watchScreen("done", 3000));
            }
            // A new chat has no text before the send; judge it from the send on.
            const judged = length === "short" ? sent : [focused, ...sent];
            const result = screenGates(readScreens(judged), "from focus to after the reply");
            result.gates[`keyboard ${keyboard} at send (setup)`] =
              keyboardAtSend === (keyboard === "up");
            result.gates["reply finished (setup)"] = replied;
            if (content === "agent") {
              // A failed tool step ends the mock's turn early; its card never draws.
              result.gates["progress card on screen (setup)"] = sent
                .flat()
                .some((sample) => sample.progressCard);
            }
            return result;
          },
        };
      }
    }
  }
  return matrix;
}

const selected = caseNames.map((name) => ({
  name,
  testCase: cases[name] ?? fail(`unknown case ${name}; known: ${Object.keys(cases).join(", ")}.`),
}));

type CaseSummary = {
  name: string;
  kind: Case["kind"];
  samples: Result[];
  passes: Record<string, number>;
  medians: Metrics;
};
const summaries: CaseSummary[] = [];
try {
  for (const { name, testCase } of selected) {
    const results: Result[] = [];
    for (let sample = 1; sample <= samples; sample += 1) {
      const session = `ux-${name}-${stamp}-${sample}`.toLowerCase();
      const file = path.join(outDir, `${name}-${sample}.jsonl`);
      // Every case is recorded for review and ends with a screen check, so cases that gate on
      // motion are also judged on what is drawn.
      const recording = path.join(outDir, `${name}-${sample}.mp4`);
      const video = spawn("xcrun", ["simctl", "io", sim, "recordVideo", "--force", recording], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      owned.recorder = video;
      // The recording's first frame is drawn when simctl reports the start. Wait for it here: the
      // cases block the event loop with synchronous commands, which would stamp the line late.
      const videoStartedAt = await new Promise<number>((resolve) => {
        const stopped = () =>
          fail(`the recording of ${name} #${sample} stopped before it started.`);
        video.once("exit", stopped);
        video.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          if (chunk.includes("Recording started")) {
            video.off("exit", stopped);
            resolve(Date.now());
          }
        });
      });
      const result = await testCase.run(session, file);
      const settled = screenGates(
        readScreens([await watchScreen(`${name}-end`, 1500)]),
        "at the end",
      );
      // Both gates: without a transcript to read, the text gate passes on zero samples.
      Object.assign(result.gates, settled.gates);
      result.metrics.endTextLines = settled.metrics.minTextLines;
      video.kill("SIGINT");
      if (video.exitCode === null) {
        await new Promise((resolve) => {
          video.once("exit", resolve);
        });
      }
      owned.recorder = undefined;
      if (result.drawnMotion) {
        const measured = result.drawnMotion.map(({ from, to, area, screenWidth, ignoreX }) => {
          const args = [area.x, area.y, area.width, area.height, screenWidth, ...(ignoreX ?? [])];
          return JSON.parse(
            run(screenMotionTool, [
              recording,
              ...[(from - videoStartedAt) / 1000, (to - videoStartedAt) / 1000].map(String),
              ...args.map((value) => String(Math.round(value))),
            ]).stdout,
          ) as { frames: number; strips: number; maxMovePt: number; unexplainedFrames: number };
        });
        result.metrics.drawnMovePt = Math.max(...measured.map((entry) => entry.maxMovePt));
        // Reported, not gated: on `main` the live bubble → final row handoff redraws the reply
        // about 2 pt right and 1 pt down for a few frames, which no vertical shift explains.
        result.metrics.drawnUnexplainedFrames = measured.reduce(
          (sum, entry) => sum + entry.unexplainedFrames,
          0,
        );
        // A window outside the recording or a blank area reads as 0 pt without seeing anything.
        result.gates["recording covers each window with content (setup)"] = measured.every(
          (entry) => entry.frames >= 2 && entry.strips >= 2,
        );
        result.gates["drawn transcript holds still (≤1 pt)"] = result.metrics.drawnMovePt <= 1;
      }
      results.push(result);
      console.log(`ios:behavior: ${name} #${sample} ${JSON.stringify(result.metrics)}`);
    }
    const passes: Record<string, number> = {};
    for (const gate of Object.keys(results[0]?.gates ?? {})) {
      passes[gate] = results.filter((result) => result.gates[gate]).length;
    }
    const medians: Metrics = {};
    for (const metric of Object.keys(results[0]?.metrics ?? {})) {
      const numbers = results
        .map((result) => result.metrics[metric])
        .filter((value): value is number => value !== undefined);
      medians[metric] = percentile(numbers, 0.5);
    }
    summaries.push({ name, kind: testCase.kind, samples: results, passes, medians });
  }
} finally {
  deleteOwnedSimulator();
}

const lines = [
  `# iOS behavior ${stamp}`,
  "",
  `${samples} samples per case. Gate column: samples that passed.`,
  "",
];
for (const summary of summaries) {
  const caseVerdict = verdict(summary.kind, summary.passes, samples);
  lines.push(
    `## ${summary.name} (${summary.kind}): ${caseVerdict}`,
    "",
    "| Gate | Result |",
    "| --- | --- |",
  );
  for (const [gate, count] of Object.entries(summary.passes)) {
    lines.push(`| ${gate} | ${count}/${samples}${count === samples ? "" : " FAIL"} |`);
  }
  lines.push("", "| Metric (median) | Value |", "| --- | --- |");
  for (const [metric, value] of Object.entries(summary.medians)) {
    lines.push(`| ${metric} | ${value ?? "n/a"} |`);
  }
  lines.push("");
}
writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summaries, null, 2));
writeFileSync(path.join(outDir, "summary.md"), lines.join("\n"));
console.log(lines.join("\n"));
console.log(`ios:behavior: probe logs and summary in ${outDir}`);
const failed = summaries.some(
  (summary) => !verdict(summary.kind, summary.passes, samples).startsWith("ok"),
);
process.exit(failed ? 1 : 0);
