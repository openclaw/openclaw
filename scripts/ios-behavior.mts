#!/usr/bin/env node
// Measures chat UX on the iOS simulator against an isolated Gateway whose model is the scripted
// QA mock: streaming follow, reading position while scrolled up, keyboard, and relaunch.
// Usage: pnpm ios:behavior [--setup] [--profile ios-ux] [--cases a,b] [--samples 3] [--app <app>]
// --setup writes the profile (Gateway stopped): loopback port, token auth, mock model.
// Then run the mock and the Gateway (see .agents/skills/ios-e2e/BEHAVIOR.md) and this script.
// IOS_SIM reuses a paired simulator; otherwise a fresh one is paired and deleted afterwards.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  type ProbeLog,
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
    cases: { type: "string", default: "stream-turn,stream-follow,scrolled-up,keyboard,relaunch" },
    samples: { type: "string", default: "3" },
    out: { type: "string" },
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

// Set once this run creates a simulator, so every exit path deletes it.
const owned: { simulator?: string } = {};

function deleteOwnedSimulator() {
  if (owned.simulator) {
    spawnSync("xcrun", ["simctl", "delete", owned.simulator]);
    owned.simulator = undefined;
  }
}

function fail(message: string): never {
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
// bootstatus returns before app launches are accepted; the first launch can fail silently.
for (let attempt = 1; ; attempt += 1) {
  if (run("xcrun", ["simctl", "launch", sim, bundleId], { allowFailure: true }).ok) {
    break;
  }
  if (attempt === 10) {
    fail("the app would not launch on the rebooted simulator.");
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

type Metrics = Record<string, number | undefined>;
type Result = { metrics: Metrics; gates: Record<string, boolean> };
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
// the reply grow below it; with the keyboard up it follows the live edge (#108692). Both are
// `bad` on main: the reply shifts when the final row replaces the live bubble, and with the
// keyboard up the growing reply is not followed.
function streamCase(keyboardUp: boolean): Case {
  return {
    kind: "bad",
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
      const moved = motion(view.frames, { aliases });
      const userMount = mountOf("user/");
      const firstText = firstFrame(view.frames, (frame) => "live" in frame.f);
      const bodies = bodyCounts(view.events);
      const last = view.frames.at(-1);
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
          (frame) => firstText !== undefined && frame.t >= firstText,
        );
        const hidden = hiddenBelowComposer(last);
        return {
          metrics: {
            ...common,
            backwardPt: moved.backwardPt,
            followLagP95Pt: percentile(
              streaming.map((frame) => hiddenBelowComposer(frame) ?? 0),
              0.95,
            ),
            hiddenAtEndPt: hidden,
          },
          gates: {
            ...setup,
            "no teleports": moved.teleports === 0,
            "no backward motion (≤1 pt)": moved.backwardPt <= 1,
            "end in view (≤4 pt hidden)": (hidden ?? Infinity) <= 4,
            "no remounts": common.remounts === 0,
          },
        };
      }
      // The one-shot move to the new turn lands within a second; after that the pin must hold.
      const pinned = motion(window(log, sentAt + 1000, end).frames, { aliases });
      const userKey = userMount?.k;
      const replyHidden = hiddenBelowComposer(last) ?? 0;
      return {
        metrics: {
          ...common,
          pinnedTopPt: userKey ? last?.f[userKey]?.[0] : undefined,
          rowDriftPt: pinned.maxDriftPt,
          replyBelowFoldPt: replyHidden,
        },
        gates: {
          ...setup,
          "reply grew past the fold (setup)": replyHidden > 100,
          "no teleports": moved.teleports === 0,
          "sent turn holds still, reply included (≤1 pt)": pinned.maxDriftPt <= 1,
          "no remounts": common.remounts === 0,
        },
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
      ui([
        "swipe",
        "--within-element-ref",
        ref(/chat-transcript/),
        "--direction",
        "down",
        "--distance",
        "0.5",
        "--duration",
        "0.3",
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
};

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
      const result = await testCase.run(session, file);
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
