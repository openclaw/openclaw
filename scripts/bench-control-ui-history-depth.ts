// Real-Gateway older-history depth benchmark. Run with node --import ./scripts/tsx.mjs.
// Usage and interpretation: scripts/bench-control-ui-history-depth.md.
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CDPSession, Page } from "playwright";
import { runtimeProcessEntrypoints } from "../src/infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../src/infra/runtime-worker-url.js";
import { bindInheritedNativeProcessOwner } from "../src/process/supervisor/inherited-process-lineage.js";
import { ensureGatewayOwnerProfile } from "../src/state/user-profiles.js";
import { acquireGatewayTestClient } from "../test/helpers/gateway-client.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../test/helpers/openclaw-test-instance.ts";
import { waitForControlUiGatewayReady } from "../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../ui/src/test-helpers/control-ui-e2e-session-urls.ts";
import { createControlUiPaneRuntimeTestAdapterScript } from "../ui/src/test-helpers/control-ui-pane-runtime.test-support.ts";
import { parseBenchmarkInteger, summarizeBenchmarkTimings } from "./lib/benchmark-harness.mts";
import {
  formatCpuTables,
  mapColdLoadCpuProfile,
  summarizeCpuProfile,
  type ColdLoadCpuProfile,
} from "./lib/control-ui-cold-load-trace.ts";
import { startEngineMeasurement } from "./lib/control-ui-engine-metrics.ts";
import { launchControlUiObservationBrowser } from "./lib/control-ui-observation-browser.ts";
import { formatErrorMessage } from "./lib/error-format.mts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    pairs: { type: "string", default: "1" },
    messages: { type: "string", default: "30000" },
    pages: { type: "string", default: "0" },
    "early-pages": { type: "string", default: "5" },
    skills: { type: "string", default: "0" },
    "other-sessions": { type: "string", default: "0" },
    "inject-interval-ms": { type: "string", default: "1000" },
    "cpu-throttle": { type: "string", default: "1" },
    "profile-pages": { type: "string", default: "" },
    "settle-ms": { type: "string", default: "250" },
    "gateway-start-timeout-ms": { type: "string", default: "180000" },
    "gateway-stop-timeout-ms": { type: "string", default: "60000" },
    output: { type: "string" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});
if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/bench-control-ui-history-depth.ts [--bundle-dir <built UI>] [--compare-bundle-dir <head UI> --pairs N] [--messages 30000] [--pages N] [--skills N] [--other-sessions N --inject-interval-ms 1000] [--cpu-throttle 4] [--profile-pages 1,20] [--output <dir>]",
  );
  process.exit(0);
}
const integer = (flag: keyof typeof values, min: number, max: number) =>
  parseBenchmarkInteger(String(values[flag]), `--${flag}`, min, max);
const options = {
  pairs: integer("pairs", 1, 100),
  messages: integer("messages", 10, 1_000_000),
  pages: integer("pages", 0, 10_000),
  earlyPages: integer("early-pages", 1, 100),
  skills: integer("skills", 0, 10_000),
  otherSessions: integer("other-sessions", 0, 1_000),
  injectIntervalMs: integer("inject-interval-ms", 10, 600_000),
  cpuThrottle: integer("cpu-throttle", 1, 20),
  profilePages: new Set(
    values["profile-pages"]
      ? values["profile-pages"]
          .split(",")
          .map((page) => parseBenchmarkInteger(page, "--profile-pages", 1, 10_000))
      : [],
  ),
  settleMs: integer("settle-ms", 0, 60_000),
  gatewayStartTimeoutMs: integer("gateway-start-timeout-ms", 1_000, 3_600_000),
  gatewayStopTimeoutMs: integer("gateway-stop-timeout-ms", 1_000, 3_600_000),
};
const bundles = [
  {
    label: values["compare-bundle-dir"] ? "base" : "bundle",
    dir: path.resolve(values["bundle-dir"]),
  },
  ...(values["compare-bundle-dir"]
    ? [{ label: "head", dir: path.resolve(values["compare-bundle-dir"]) }]
    : []),
];
const output = path.resolve(
  values.output ??
    `.artifacts/control-ui-history-depth/${new Date().toISOString().replaceAll(":", "-")}`,
);
const sessionKey = "agent:main:history-depth-proof";
const viewport = { width: 1440, height: 900 };
// One wheel event reaches the top with smooth scrolling disabled, like a reader's flick.
const wheelDeltaY = -1_000_000;
const wheelAttempts = 3;
const wheelAttemptTimeoutMs = 5_000;
const pageTimeoutMs = 120_000;
// Crowding sessions are small; they exist to receive background writes.
const otherSessionMessages = 200;

type BenchPane = HTMLElement & {
  sessionKey: string;
  transcriptLoading: boolean;
  loadingOlder: boolean;
  historyIntentTimer: number | null;
  // Absent until the pane binds its session.
  state?: { chatMessages: unknown[] };
};
type ProbeResult = {
  before: number;
  after: number;
  wheels: number;
  wheelToChangeMs: number | null;
  wheelToIdleMs: number | null;
  longTasks: { count: number; totalMs: number; maxMs: number };
  renderedRows: number;
};
type ProbeWindow = typeof window & {
  historyDepthProbe: {
    arm: () => void;
    state: () => { started: boolean; idle: boolean };
    result: () => ProbeResult;
  };
};
type HistoryRpc = {
  method: string;
  sentAt: number;
  receivedAt?: number;
  ok?: boolean;
  cursor: boolean;
  olderCursor?: boolean;
  messages?: number;
  responseBytes?: number;
};

// Deterministic, realistic transcript content: markdown, links, tables, fenced code,
// and tool call -> tool result (20-220 lines) -> reply turns.
function seedTranscript(count: number, label: string, baseTime: number) {
  const topics = ["session routing", "history paging", "model catalog", "plugin loader"];
  const files = ["gateway/server", "ui/chat-thread", "agents/runtime", "plugins/registry"];
  const messages: Array<{ message: Record<string, unknown> }> = [];
  const push = (message: Record<string, unknown>) => {
    if (messages.length < count) {
      messages.push({ message: { ...message, timestamp: baseTime + messages.length * 1_000 } });
    }
  };
  for (let turn = 0; messages.length < count; turn += 1) {
    const topic = topics[turn % topics.length]!;
    const file = files[(turn * 7) % files.length]!;
    push({
      role: "user",
      content: [
        {
          type: "text",
          text: `${label} turn ${turn + 1}: can you check **${topic}** in \`src/${file}.ts\`?\n\n- keep the public contract\n- compare with [the docs](https://docs.openclaw.ai/${topic.replace(" ", "-")})`,
        },
      ],
    });
    if (turn % 3 !== 2) {
      const toolCallId = `call-${label}-${turn}`;
      const lines = 20 + ((turn * 37) % 201);
      push({
        role: "assistant",
        content: [
          { type: "text", text: `Reading \`src/${file}.ts\` before answering.` },
          {
            type: "toolCall",
            id: toolCallId,
            name: "exec",
            arguments: { command: `sed -n 1,${lines}p src/${file}.ts` },
          },
        ],
      });
      push({
        role: "toolResult",
        toolCallId,
        toolName: "exec",
        isError: false,
        content: [
          {
            type: "text",
            text: Array.from(
              { length: lines },
              (_, line) =>
                `${String(line + 1).padStart(4)}  export const ${topic.split(" ")[0]}${line} = resolve("${file}", ${(turn * line) % 997});`,
            ).join("\n"),
          },
        ],
      });
    }
    push({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `### ${topic} findings (${label} ${turn + 1})\n\nThe [${file}](https://github.com/openclaw/openclaw/blob/main/src/${file}.ts) owner keeps ${topic} consistent.\n\n| Check | Result |\n| --- | --- |\n| Types | ok |\n| Tests | ${turn % 50} passed |\n\n\`\`\`ts\nexport function check${turn}(input: string) {\n  return input.trim().length > ${turn % 10};\n}\n\`\`\`\n\nNext I would review the callers.`,
        },
      ],
    });
  }
  return messages;
}

function median(numbers: number[]) {
  return numbers.length ? summarizeBenchmarkTimings(numbers).p50 : null;
}

async function cliJson(owner: OpenClawTestInstance, args: string[]) {
  // The handoff CLI is a separate process on a loaded host; retry transient failures.
  let lastError = "";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await owner.cli(["--no-color", ...args], { timeoutMs: 120_000 });
    if (result.code === 0) {
      try {
        return { value: JSON.parse(result.stdout) as Record<string, unknown>, attempts: attempt };
      } catch (error) {
        lastError = formatErrorMessage(error);
      }
    } else {
      lastError = `exit ${String(result.code)}: ${[result.stderr, result.stdout].join("\n")}`;
    }
    await sleep(attempt * 2_000);
  }
  throw new Error(
    `${args.join(" ")} failed after 4 attempts: ${lastError.replaceAll(owner.gatewayToken, "[redacted]")}`,
  );
}

async function readBuildId(dir: string) {
  const source = await readFile(path.join(dir, "sw.js"), "utf8").catch(() => "");
  return /EMBEDDED_CACHE_VERSION = "([^"]+)"/u.exec(source)?.[1] ?? null;
}

function trackHistoryRpc(page: Page) {
  const records: HistoryRpc[] = [];
  const pending = new Map<string, HistoryRpc>();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as {
        id?: unknown;
        method?: unknown;
        params?: Record<string, unknown>;
      };
      const params = frame.params ?? {};
      const initial = params.initialHistory as Record<string, unknown> | undefined;
      const history = frame.method === "chat.history" ? params : initial;
      if (
        typeof frame.id !== "string" ||
        !history ||
        (params.sessionKey ?? params.key) !== sessionKey
      ) {
        return;
      }
      const record: HistoryRpc = {
        method: String(frame.method),
        sentAt: Date.now(),
        cursor: typeof history.cursor === "string",
      };
      records.push(record);
      pending.set(frame.id, record);
    });
    socket.on("framereceived", ({ payload }) => {
      const text = payload.toString();
      const frame = JSON.parse(text) as { id?: unknown; ok?: unknown; payload?: unknown };
      const record = typeof frame.id === "string" ? pending.get(frame.id) : undefined;
      if (!record || typeof frame.id !== "string") {
        return;
      }
      pending.delete(frame.id);
      const body = (frame.payload ?? {}) as Record<string, unknown>;
      const initial = body.initialHistory as Record<string, unknown> | undefined;
      const history = (
        record.method === "chat.history" ? body : (initial?.payload ?? {})
      ) as Record<string, unknown>;
      record.receivedAt = Date.now();
      record.ok = frame.ok === true;
      record.responseBytes = Buffer.byteLength(text);
      record.olderCursor = typeof history.olderCursor === "string";
      record.messages = Array.isArray(history.messages) ? history.messages.length : undefined;
    });
  });
  return { records, inFlight: () => pending.size };
}

async function waitForHistoryQuiet(page: Page, inFlight: () => number, settleMs: number) {
  const deadline = Date.now() + pageTimeoutMs;
  const quiet = () =>
    page.evaluate(() => {
      const pane = document.querySelector<BenchPane>(
        "openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])",
      );
      return Boolean(pane && !pane.loadingOlder && pane.historyIntentTimer === null);
    });
  // A committed page stages its successor; wait for that read so each page measures a commit.
  for (let settled = 0; settled < 2;) {
    if (Date.now() > deadline) {
      throw new Error("Older history did not become quiet");
    }
    if (inFlight() === 0 && (await quiet())) {
      settled += 1;
      await sleep(settled === 1 ? settleMs : 0);
    } else {
      settled = 0;
      await sleep(50);
    }
  }
}

async function installProbe(page: Page) {
  await page.evaluate(() => {
    const pane = document.querySelector<BenchPane>(
      "openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])",
    )!;
    const longTasks: Array<{ start: number; end: number }> = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ start: entry.startTime, end: entry.startTime + entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
    type Sample = {
      first: unknown;
      before: number;
      wheels: number;
      wheelAt?: number;
      changeAt?: number;
      idleAt?: number;
    };
    let current: Sample | undefined;
    // Read live, not per frame: a long commit can block frames while input queues.
    const started = (sample: Sample) =>
      sample.changeAt !== undefined ||
      pane.state!.chatMessages[0] !== sample.first ||
      pane.loadingOlder ||
      pane.historyIntentTimer !== null;
    pane.addEventListener(
      "wheel",
      (event) => {
        // Capture runs before the pane consumes the intent. Only a wheel that found no
        // load underway starts the interval; a retry replaces an ineffective wheel.
        if (current && !started(current)) {
          current.wheelAt = event.timeStamp;
          current.wheels += 1;
        }
      },
      { capture: true, passive: true },
    );
    (window as ProbeWindow).historyDepthProbe = {
      arm() {
        const sample: Sample = {
          first: pane.state!.chatMessages[0],
          before: pane.state!.chatMessages.length,
          wheels: 0,
        };
        current = sample;
        let quietFrames = 0;
        const tick = () => {
          const now = performance.now();
          if (sample.changeAt === undefined && pane.state!.chatMessages[0] !== sample.first) {
            sample.changeAt = now;
          }
          if (sample.changeAt !== undefined) {
            quietFrames =
              !pane.loadingOlder && pane.historyIntentTimer === null ? quietFrames + 1 : 0;
            if (quietFrames >= 2) {
              sample.idleAt = now;
              return;
            }
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      state: () => ({
        started: current !== undefined && started(current),
        idle: current?.idleAt !== undefined,
      }),
      result() {
        const sample = current!;
        const start = sample.wheelAt ?? Infinity;
        // Same interval as the CPU counters: through the staged successor read.
        const end = performance.now();
        const durations = longTasks
          .filter((task) => task.end >= start && task.start <= end)
          .map((task) => task.end - task.start);
        const elapsed = (at: number | undefined) =>
          at !== undefined && sample.wheelAt !== undefined ? at - sample.wheelAt : null;
        return {
          before: sample.before,
          after: pane.state!.chatMessages.length,
          wheels: sample.wheels,
          wheelToChangeMs: elapsed(sample.changeAt),
          wheelToIdleMs: elapsed(sample.idleAt),
          longTasks: {
            count: durations.length,
            totalMs: durations.reduce((sum, value) => sum + value, 0),
            maxMs: Math.max(0, ...durations),
          },
          renderedRows: pane.querySelectorAll(".chat-virtual-row").length,
        };
      },
    };
  });
}

async function startProfiler(page: Page) {
  const session: CDPSession = await page.context().newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.start");
  return async () => {
    try {
      return (await session.send("Profiler.stop")).profile as ColdLoadCpuProfile;
    } finally {
      await session.detach();
    }
  };
}

type PageRecord = ProbeResult & {
  page: number;
  profiled: boolean;
  scriptMs: number | null;
  taskMs: number | null;
  layoutMs: number | null;
  styleMs: number | null;
  layoutCount: number | null;
  styleCount: number | null;
  heapMb: number | null;
  chatHistory: Array<HistoryRpc & { latencyMs?: number }>;
  cpuProfile?: string;
};

async function runSample(params: {
  owner: OpenClawTestInstance;
  bundle: (typeof bundles)[number];
  sampleDir: string;
}) {
  const { owner, bundle, sampleDir } = params;
  await mkdir(sampleDir, { recursive: true });
  const handoff = await cliJson(owner, ["dashboard", "--json"]);
  const baseUrl = `http://127.0.0.1:${owner.port}/`;
  const url = new URL(controlUiSessionUrl(baseUrl, sessionKey));
  url.hash = new URL(String(handoff.value.browserUrl)).hash;
  const browser = await launchControlUiObservationBrowser({
    viewport,
    artifactDir: sampleDir,
    artifactPrefix: "browser",
    colorScheme: "light",
    args: ["--disable-smooth-scrolling"],
  });
  const pages: PageRecord[] = [];
  // The real-Gateway E2E adapter exposes the pane's history owner (messages, loading state).
  await browser.context.addInitScript({ content: createControlUiPaneRuntimeTestAdapterScript() });
  // tsx keeps function names with a helper that page.evaluate callbacks do not carry.
  await browser.context.addInitScript("globalThis.__name = (fn) => fn");
  const page = await browser.context.newPage();
  try {
    await page.addInitScript(() =>
      window.localStorage.setItem(
        "openclaw:control-ui:community-invite:v2",
        JSON.stringify({ dismissedAtMs: 1770000000000 }),
      ),
    );
    const rpc = trackHistoryRpc(page);
    const bootStarted = Date.now();
    await page.goto(url.toString());
    // The handoff opens the public document; its login link enters the app.
    const login = page.getByRole("link", { name: "Log in", exact: true });
    const entryUrl = await login.evaluate((element: HTMLAnchorElement) => element.href);
    const [navigation] = await Promise.all([
      page.waitForResponse(
        (response) => response.request().isNavigationRequest() && response.url() === entryUrl,
      ),
      login.click(),
    ]);
    if (navigation.status() !== 200) {
      throw new Error(`Session entry returned HTTP ${navigation.status()}`);
    }
    await waitForControlUiGatewayReady(page, pageTimeoutMs);
    await page.waitForFunction(
      (key) => {
        const pane = document.querySelector<BenchPane>(
          "openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])",
        );
        return (
          pane?.sessionKey === key &&
          !pane.transcriptLoading &&
          (pane.state?.chatMessages.length ?? 0) > 0
        );
      },
      sessionKey,
      { timeout: pageTimeoutMs },
    );
    const bootMs = Date.now() - bootStarted;
    const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])");
    const box = await pane.locator(".chat-thread").boundingBox();
    if (!box) {
      throw new Error("Chat thread has no layout box");
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // Emulation state belongs to its CDP session; keep it attached for the whole sample.
    const throttle = await page.context().newCDPSession(page);
    await throttle.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle });
    await installProbe(page);
    const loadedCount = () =>
      pane.evaluate((element) => (element as BenchPane).state!.chatMessages.length);
    const initialMessages = await loadedCount();
    let stalled = false;
    for (let index = 1; options.pages === 0 || index <= options.pages; index += 1) {
      await waitForHistoryQuiet(page, rpc.inFlight, options.settleMs);
      if ((await loadedCount()) >= options.messages) {
        break;
      }
      const profiled = options.profilePages.has(index);
      const startedAt = Date.now();
      const measurement = await startEngineMeasurement(page, "chromium", { trace: false });
      const stopProfiler = profiled ? await startProfiler(page) : undefined;
      await page.evaluate(() => (window as ProbeWindow).historyDepthProbe.arm());
      const probeState = () =>
        page.evaluate(() => (window as ProbeWindow).historyDepthProbe.state());
      let started = false;
      // Retry only a wheel that started no load; a slow load keeps its first wheel.
      for (let attempt = 0; attempt < wheelAttempts && !started; attempt += 1) {
        await page.mouse.wheel(0, wheelDeltaY);
        started = await page
          .waitForFunction(() => (window as ProbeWindow).historyDepthProbe.state().started, null, {
            timeout: wheelAttemptTimeoutMs,
          })
          .then(
            () => true,
            // A blocked main thread cannot answer the poll; ask once more after it yields.
            async () => (await probeState()).started,
          );
      }
      if (started) {
        await page.waitForFunction(
          () => (window as ProbeWindow).historyDepthProbe.state().idle,
          null,
          { timeout: pageTimeoutMs },
        );
        // Include the staged successor read that this commit starts.
        await waitForHistoryQuiet(page, rpc.inFlight, options.settleMs);
      }
      const profile = await stopProfiler?.();
      const { metrics } = await measurement.stop();
      const endedAt = Date.now();
      const probe = await page.evaluate(() => (window as ProbeWindow).historyDepthProbe.result());
      const record: PageRecord = {
        page: index,
        profiled,
        ...probe,
        scriptMs: metrics.scriptMs,
        taskMs: metrics.taskMs,
        layoutMs: metrics.layoutMs,
        styleMs: metrics.styleMs,
        layoutCount: metrics.layoutCount,
        styleCount: metrics.styleCount,
        heapMb: metrics.jsHeapUsedBytes === null ? null : metrics.jsHeapUsedBytes / 1024 / 1024,
        chatHistory: rpc.records
          .filter((read) => read.sentAt >= startedAt && read.sentAt <= endedAt)
          .map((read) =>
            Object.assign({}, read, {
              sentAt: read.sentAt - startedAt,
              receivedAt: read.receivedAt === undefined ? undefined : read.receivedAt - startedAt,
              latencyMs: read.receivedAt === undefined ? undefined : read.receivedAt - read.sentAt,
            }),
          ),
      };
      if (profile) {
        const mapped = await mapColdLoadCpuProfile(profile, {
          assetBaseUrl: new URL("assets/", baseUrl).href,
          assetDirectory: path.join(bundle.dir, "assets"),
        });
        const summary = summarizeCpuProfile(mapped.profile, { includeTables: true });
        record.cpuProfile = path.join(sampleDir, `page-${index}.cpuprofile`);
        await writeFile(record.cpuProfile, JSON.stringify(mapped.profile));
        await writeFile(
          path.join(sampleDir, `page-${index}.cpu.txt`),
          `${formatCpuTables(`Page ${index} CPU (profiled; timings inflated)`, summary.tables!)}\nMapped frames: ${mapped.mappedFrames}; unmapped: ${mapped.unmappedFrames}\n`,
        );
      }
      pages.push(record);
      console.log(
        `[history-depth] ${bundle.label} page ${index}: ${probe.before} -> ${probe.after} messages, wheel->change ${probe.wheelToChangeMs?.toFixed(0) ?? "n/a"} ms, script ${metrics.scriptMs?.toFixed(0) ?? "n/a"} ms${profiled ? " (profiled)" : ""}`,
      );
      if (!started) {
        stalled = true;
        break;
      }
    }
    await throttle.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    // Each loaded row must appear once, in transcript order.
    const verification = await pane.evaluate((element) => {
      const metadata = (
        (element as BenchPane).state!.chatMessages as Array<
          Record<string, { id?: unknown; seq?: unknown } | undefined>
        >
      ).map((message) => message["__openclaw"]);
      const ids = metadata.flatMap((meta) => (meta?.id == null ? [] : [meta.id]));
      const seqs = metadata.flatMap((meta) => (typeof meta?.seq === "number" ? [meta.seq] : []));
      return {
        loaded: metadata.length,
        withId: ids.length,
        uniqueIds: new Set(ids).size,
        withSeq: seqs.length,
        seqAscending: seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!),
        firstSeq: seqs[0] ?? null,
        lastSeq: seqs.at(-1) ?? null,
      };
    });
    await page.screenshot({ path: path.join(sampleDir, "final.png") });
    return {
      handoffAttempts: handoff.attempts,
      bootMs,
      initialMessages,
      stalled,
      pages,
      verification: {
        ...verification,
        expected: options.messages,
        ok:
          verification.uniqueIds === verification.withId &&
          verification.withSeq === verification.loaded &&
          verification.seqAscending,
        complete: verification.loaded === options.messages,
      },
    };
  } catch (error) {
    // Failed samples keep what the page showed and each pane's binding.
    await page.screenshot({ path: path.join(sampleDir, "failure.png") }).catch(() => {});
    const panes = await page
      .evaluate(() =>
        [...document.querySelectorAll<BenchPane>("openclaw-chat-pane")].map((pane) => ({
          className: pane.className,
          sessionKey: pane.sessionKey,
          transcriptLoading: pane.transcriptLoading,
          messages: pane.state?.chatMessages.length ?? null,
        })),
      )
      .catch(() => []);
    await writeFile(
      path.join(sampleDir, "failure.json"),
      JSON.stringify({ url: new URL(page.url()).pathname, panes }, null, 2),
    );
    throw error;
  } finally {
    await browser.close().catch((error: unknown) => {
      console.warn(`[history-depth] browser close failed: ${formatErrorMessage(error)}`);
    });
  }
}

const metricNames = [
  "wheelToChangeMs",
  "wheelToIdleMs",
  "scriptMs",
  "taskMs",
  "layoutMs",
  "styleMs",
  "longTaskTotalMs",
  "longTaskMaxMs",
  "heapMb",
  "historyLatencyMs",
  "historyBytes",
] as const;
type MetricName = (typeof metricNames)[number];

function readMetric(page: PageRecord, name: MetricName): number | null {
  const value =
    name === "longTaskTotalMs"
      ? page.longTasks.totalMs
      : name === "longTaskMaxMs"
        ? page.longTasks.maxMs
        : name === "historyLatencyMs"
          ? median(page.chatHistory.flatMap((read) => read.latencyMs ?? []))
          : name === "historyBytes"
            ? page.chatHistory.reduce((sum, read) => sum + (read.responseBytes ?? 0), 0)
            : page[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Early pages run against a short loaded history, late pages against nearly all of it.
function summarize(samples: ReadonlyArray<{ label: string; pages?: PageRecord[] }>) {
  return Object.fromEntries(
    bundles.flatMap(({ label }) => {
      const runs = samples.flatMap((sample) =>
        sample.label === label && sample.pages?.length ? [sample.pages] : [],
      );
      if (runs.length === 0) {
        return [];
      }
      const measured = Math.min(...runs.map((pages) => pages.length));
      const width = Math.max(1, Math.min(options.earlyPages, Math.floor(measured / 2)));
      const early = Array.from({ length: width }, (_, index) => index + 1);
      const late = Array.from({ length: width }, (_, index) => measured - width + index + 1);
      const pick = (indexes: number[], name: MetricName) =>
        median(
          runs.flatMap((run) =>
            run.flatMap((page) =>
              indexes.includes(page.page) && !page.profiled ? (readMetric(page, name) ?? []) : [],
            ),
          ),
        );
      const perPage = Array.from({ length: measured }, (_, index) => ({
        page: index + 1,
        loadedAfter: median(runs.map((run) => run[index]!.after)),
        ...Object.fromEntries(
          metricNames.map((name) => [
            name,
            median(
              runs.flatMap((run) =>
                run[index]!.profiled ? [] : (readMetric(run[index]!, name) ?? []),
              ),
            ),
          ]),
        ),
      })) as Array<
        { page: number; loadedAfter: number | null } & Record<MetricName, number | null>
      >;
      const metrics = Object.fromEntries(
        metricNames.map((name) => {
          const earlyValue = pick(early, name);
          const lateValue = pick(late, name);
          return [
            name,
            {
              early: earlyValue,
              late: lateValue,
              ratio: earlyValue && lateValue !== null ? lateValue / earlyValue : null,
            },
          ];
        }),
      ) as Record<MetricName, { early: number | null; late: number | null; ratio: number | null }>;
      return [
        [label, { samples: runs.length, measuredPages: measured, early, late, metrics, perPage }],
      ];
    }),
  );
}

function formatSummary(summary: ReturnType<typeof summarize>, hostLoad: unknown) {
  const format = (value: number | null, digits = 1) =>
    value === null ? "n/a" : value.toFixed(digits);
  const lines = [
    `# Control UI older-history depth: ${options.messages} messages, ${options.cpuThrottle}x CPU`,
    "",
    `Host load (1/5/15 min, ${availableParallelism()} CPUs): ${JSON.stringify(hostLoad)}`,
    "",
  ];
  for (const [label, entry] of Object.entries(summary)) {
    lines.push(
      `## ${label}: ${entry.samples} sample(s), ${entry.measuredPages} pages (early ${entry.early.join(",")}; late ${entry.late.join(",")})`,
      "",
      "| Metric (median) | Early | Late | Late/early |",
      "| --- | ---: | ---: | ---: |",
      ...metricNames.map((name) => {
        const metric = entry.metrics[name];
        return `| ${name} | ${format(metric.early)} | ${format(metric.late)} | ${format(metric.ratio, 2)} |`;
      }),
      "",
      "| Page | Loaded | Wheel→change ms | Script ms | Task ms | Layout ms | Style ms | Max long task ms | Heap MB | chat.history ms |",
      "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...entry.perPage.map(
        (row) =>
          `| ${row.page} | ${format(row.loadedAfter, 0)} | ${format(row.wheelToChangeMs, 0)} | ${format(row.scriptMs, 0)} | ${format(row.taskMs, 0)} | ${format(row.layoutMs, 0)} | ${format(row.styleMs, 0)} | ${format(row.longTaskMaxMs, 0)} | ${format(row.heapMb, 0)} | ${format(row.historyLatencyMs, 0)} |`,
      ),
      "",
    );
  }
  return lines.join("\n");
}

await mkdir(output, { recursive: true });
const resultsPath = path.join(output, "results.json");
const report: Record<string, unknown> = {
  benchmark: "control-ui-history-depth",
  startedAt: new Date().toISOString(),
  argv: process.argv.slice(2),
  options: { ...options, profilePages: [...options.profilePages] },
  bundles: await Promise.all(
    bundles.map(async (bundle) => ({
      ...bundle,
      realPath: await realpath(bundle.dir),
      buildId: await readBuildId(bundle.dir),
    })),
  ),
};
const hostLoad: { cpus: number; start: number[]; end?: number[] } = {
  cpus: availableParallelism(),
  start: loadavg(),
};
const gateway: Record<string, unknown> = {};
const samples: Array<Record<string, unknown> & { label: string; pages?: PageRecord[] }> = [];
const save = () =>
  writeFile(resultsPath, `${JSON.stringify({ ...report, hostLoad, gateway, samples }, null, 2)}\n`);

// A source-run script must spawn the Gateway under the built process-tree anchor;
// the anchor cannot load this process's source hooks.
bindInheritedNativeProcessOwner(
  resolveRuntimeWorkerUrl({
    ...runtimeProcessEntrypoints.serviceChildGroupAnchor,
    root: fileURLToPath(new URL("..", import.meta.url)),
  }).href,
);
const owner = await createOpenClawTestInstance({
  name: "history-depth",
  // Full Gateway, as in the real-Gateway loading E2E.
  env: { OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
  // Readiness on a loaded shared host can exceed the helper's default.
  startTimeoutMs: options.gatewayStartTimeoutMs,
  stopTimeoutMs: options.gatewayStopTimeoutMs,
});
// Env-less lookups in this process must resolve the isolated state, never the operator's.
for (const key of ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]) {
  process.env[key] = owner.env[key];
}
let stopInjection: (() => Promise<void>) | undefined;
let setupClient: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
try {
  const workspace = owner.state.path("workspace");
  for (let index = 0; index < options.skills; index += 1) {
    const name = `bench-skill-${index}`;
    await mkdir(path.join(workspace, "skills", name), { recursive: true });
    await writeFile(
      path.join(workspace, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Synthetic benchmark skill ${index} that crowds the skill catalog.\n---\n\n# ${name}\n\nFollow synthetic procedure ${index}.\n`,
    );
  }
  await mkdir(workspace, { recursive: true });
  // A configured root opts out of the bundled build-identity check, so any built bundle
  // can connect. Root reads are uncached and path-based, so samples rename their staged
  // copy into this fixed served path.
  const servedRoot = owner.state.path("control-ui");
  const stagedRoot = (label: string) => owner.state.path(`control-ui-${label}`);
  for (const bundle of bundles) {
    await cp(bundle.dir, stagedRoot(bundle.label), { recursive: true });
  }
  let served = bundles[0]!.label;
  await rename(stagedRoot(served), servedRoot);
  const config = {
    agents: {
      defaults: { workspace },
      entries: { main: { workspace, identity: { name: "History depth assistant" } } },
    },
    gateway: {
      port: owner.port,
      auth: { mode: "token" as const, token: owner.gatewayToken },
      controlUi: { enabled: true, root: servedRoot },
    },
  };
  await owner.state.writeConfig(config);
  // Seed the shared-secret owner before any client could adopt this machine's account name.
  ensureGatewayOwnerProfile("Synthetic Viewer", { env: owner.env });
  const gatewayStarted = Date.now();
  await owner.startGateway();
  gateway.startMs = Date.now() - gatewayStarted;
  console.log(`[history-depth] Gateway ready in ${String(gateway.startMs)} ms`);

  const { appendTranscriptMessages } = await import("../src/config/sessions/session-accessor.js");
  const client = await acquireGatewayTestClient(
    {
      url: owner.url,
      token: owner.gatewayToken,
      env: owner.env,
      clientName: "cli",
      mode: "cli",
      role: "operator",
      instanceId: randomUUID(),
      // chat.inject requires admin; the same client seeds sessions.
      scopes: ["operator.admin"],
      caps: ["ultrafast"],
      deviceIdentity: null,
      deviceAuthScope: owner.url,
      sharedStateMode: "read-only",
      requestTimeoutMs: 60_000,
    },
    {
      timeoutMs: 60_000,
      timeoutMessage: "History depth setup client did not connect",
      closeMessage: "History depth setup client closed during connect",
    },
  );
  setupClient = client;
  const seedStarted = Date.now();
  const otherKeys = Array.from(
    { length: options.otherSessions },
    (_, index) => `agent:main:history-depth-other-${index}`,
  );
  for (const [key, count] of [
    [sessionKey, options.messages] as const,
    ...otherKeys.map((other) => [other, otherSessionMessages] as const),
  ]) {
    const created = await client.request("sessions.create", {
      key,
      agentId: "main",
      label: key === sessionKey ? "History depth proof" : key.split(":").at(-1),
    });
    if (created.ok !== true) {
      throw new Error(`sessions.create failed for ${key}`);
    }
    const messages = seedTranscript(
      count,
      key === sessionKey ? "Depth" : "Other",
      1_780_000_000_000,
    );
    for (let offset = 0; offset < messages.length; offset += 2_000) {
      await appendTranscriptMessages(
        { agentId: "main", sessionKey: key, sessionId: String(created.sessionId), env: owner.env },
        { config, messages: messages.slice(offset, offset + 2_000) },
      );
    }
  }
  Object.assign(gateway, {
    seedMs: Date.now() - seedStarted,
    skills: options.skills,
    otherSessions: options.otherSessions,
  });
  console.log(`[history-depth] Seeded transcripts in ${String(gateway.seedMs)} ms`);

  if (otherKeys.length > 0) {
    // Fixed-interval background writes keep session events flowing to the browser.
    const injection = {
      intervalMs: options.injectIntervalMs,
      sent: 0,
      ok: 0,
      failed: 0,
      lastError: undefined as string | undefined,
    };
    gateway.injection = injection;
    const stop = new AbortController();
    const loop = (async () => {
      for (let index = 0; !stop.signal.aborted; index += 1) {
        const started = Date.now();
        injection.sent += 1;
        await client
          .request("chat.inject", {
            sessionKey: otherKeys[index % otherKeys.length]!,
            message: `Background update ${index}: synthetic activity.`,
          })
          .then(
            () => (injection.ok += 1),
            (error: unknown) => {
              injection.failed += 1;
              injection.lastError = formatErrorMessage(error);
            },
          );
        await sleep(Math.max(0, options.injectIntervalMs - (Date.now() - started)));
      }
    })();
    stopInjection = () => {
      stop.abort();
      return loop;
    };
  }

  for (let pair = 0; pair < options.pairs; pair += 1) {
    // Alternate the order each pair so drift on a shared host does not favor one bundle.
    for (const bundle of pair % 2 === 0 ? bundles : bundles.toReversed()) {
      if (served !== bundle.label) {
        await rename(servedRoot, stagedRoot(served));
        await rename(stagedRoot(bundle.label), servedRoot);
        served = bundle.label;
      }
      const sampleDir = path.join(output, `pair-${pair + 1}-${bundle.label}`);
      const loadBefore = loadavg();
      try {
        const result = await runSample({ owner, bundle, sampleDir });
        samples.push({
          label: bundle.label,
          pair: pair + 1,
          loadBefore,
          loadAfter: loadavg(),
          ...result,
        });
        if (!result.verification.ok || !result.verification.complete) {
          console.warn(
            `[history-depth] ${bundle.label} verification: ${JSON.stringify(result.verification)}`,
          );
        }
      } catch (error) {
        samples.push({
          label: bundle.label,
          pair: pair + 1,
          loadBefore,
          error: formatErrorMessage(error),
        });
        console.error(
          `[history-depth] ${bundle.label} pair ${pair + 1} failed: ${formatErrorMessage(error)}`,
        );
      }
      await save();
    }
  }
} finally {
  await stopInjection?.();
  hostLoad.end = loadavg();
  report.finishedAt = new Date().toISOString();
  const summary = summarize(samples);
  report.summary = summary;
  await save();
  if (Object.keys(summary).length > 0) {
    const text = formatSummary(summary, hostLoad);
    await writeFile(path.join(output, "summary.md"), `${text}\n`);
    console.log(text);
  }
  await writeFile(
    path.join(output, "gateway.log"),
    [owner.gatewayToken, owner.hookToken].reduce(
      (log, token) => log.replaceAll(token, "[redacted]"),
      owner.logs(),
    ),
  );
  // Results are already on disk; a slow teardown is reported, never allowed to lose them.
  try {
    await setupClient?.stopAndWait({ timeoutMs: 5_000 });
    await owner.cleanup();
    gateway.cleanup = { ok: true };
  } catch (error) {
    gateway.cleanup = { ok: false, error: formatErrorMessage(error) };
    console.warn(
      `[history-depth] Gateway cleanup failed; results kept: ${formatErrorMessage(error)}`,
    );
  }
  await save();
  console.log(`[history-depth] Results: ${resultsPath}`);
}
