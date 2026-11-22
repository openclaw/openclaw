/** Measure selected-agent Usage opens on built Control UI + Gateway, with synthetic state. */
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { chromium, type JSHandle, type Page } from "playwright";
import { acquireGatewayE2ePortBlock } from "../src/gateway/test-helpers.listener.ts";
import { createRedactingStreamWriter } from "../src/logging/redacting-stream.ts";
import { CONTROL_UI_TOKEN_SESSION_KEY_PREFIX } from "../src/shared/control-ui-storage.ts";
import type { SessionsUsageResult } from "../src/shared/usage-types.ts";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { stopGatewayGracefully } from "./lib/gateway-bench-child.ts";
import { hashFile } from "./lib/gateway-bench-installed-package.ts";
import { measureGatewayCpuUsage, readGatewayCpuUsage } from "./lib/gateway-bench-profile.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
} from "./lib/gateway-bench-runtime.ts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import type { ForegroundHistoryWindow } from "./lib/usage-foreground-history.ts";
import {
  seedUsageTeam,
  USAGE_AGENT,
  USAGE_AGENTS,
  type UsageTruth,
} from "./lib/usage-team-bench-fixture.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
    fixture: { type: "string" },
    out: { type: "string" },
    pairs: { type: "string", default: "5" },
    sessions: { type: "string", default: "6000" },
    seed: { type: "boolean" },
    unprojected: { type: "boolean" },
    screenshots: { type: "boolean" },
    "deadline-ms": { type: "string", default: "90000" },
    preset: { type: "boolean" },
    "foreground-history": { type: "boolean" },
  },
});
assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC", "Set TZ=UTC");
assert(values.fixture, "--fixture required");
assert(
  !values["foreground-history"] ||
    (values.head && !values.seed && !values.preset && !values.screenshots),
  "--foreground-history requires a separate base/head run without --seed, --preset or --screenshots",
);
const fixture = path.resolve(values.fixture);
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
if (values.seed) {
  const truth = await seedUsageTeam(
    fixture,
    Number(values.sessions),
    new Date().toISOString().slice(0, 10),
    !values.unprojected,
  );
  console.info(
    JSON.stringify({
      families: truth.families,
      instances: truth.instances,
      tokens: truth.tokens,
      cents: truth.cents,
    }),
  );
} else {
  assert(values.base && values.out, "--base and --out required");
  await compare(values.base, values.head, values.out);
}

async function build(checkout: string) {
  const root = path.resolve(checkout);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const revision = git("rev-parse", "HEAD");
  assert.equal(
    git("status", "--porcelain", "--untracked-files=no"),
    "",
    "Built source must be clean",
  );
  const dist = path.join(root, "dist");
  const buildInfo = JSON.parse(await readFile(path.join(dist, "build-info.json"), "utf8"));
  assert.equal(buildInfo.commit, revision);
  for (const name of [".buildstamp", ".runtime-postbuildstamp"]) {
    const stamp = JSON.parse(await readFile(path.join(dist, name), "utf8"));
    assert.equal(stamp.head, revision);
    assert.equal(stamp.inputsClean, true);
  }
  const ui = path.join(dist, "control-ui");
  const index = await readFile(path.join(ui, "index.html"), "utf8");
  const asset = index.match(/assets\/(index-[^"'\s]+\.js)/u)?.[1];
  assert(asset, "Missing built UI entry chunk");
  const entry = path.join(dist, "entry.js");
  return {
    root,
    revision,
    entry,
    entryHash: await hashFile(entry),
    ui,
    asset,
    assetHash: await hashFile(path.join(ui, "assets", asset)),
  };
}

type WireResponse = {
  id: string;
  method: string;
  params: Record<string, unknown>;
  requestMs: number;
  ms: number;
  ok: boolean;
  bytes: number;
  error?: string;
  usage?: ReturnType<typeof projectResponse>;
};
function projectResponse(result: SessionsUsageResult) {
  const totals = result.totals;
  return {
    tokens: totals.totalTokens,
    cents: Math.round(totals.totalCost * 100),
    rowsTotal: result.overview?.total,
    activeFamilies: result.overview?.selectedSessionCount,
    days: Object.fromEntries(
      result.aggregates.daily.filter((day) => day.tokens > 0).map((day) => [day.date, day.tokens]),
    ),
    partial: result.partial?.reason,
    cacheStatus: result.cacheStatus,
    rows: result.sessions.map((row) => ({
      key: row.key,
      label: row.label,
      agentId: row.agentId,
      tokens: row.usage?.totalTokens,
      cents: row.usage && Math.round(row.usage.totalCost * 100),
      retained: row.historicalInstanceCount,
      computing: row.computing,
    })),
  };
}

function watchWire(page: Page, token: string, onResponse?: (response: WireResponse) => void) {
  const requests: Array<{
    id: string;
    method: string;
    params: Record<string, unknown>;
    requestMs: number;
    bytes: number;
  }> = [];
  const responses: WireResponse[] = [];
  const events: Array<{ name: string; ms: number; usageUpdatedAt: number; failed: boolean }> = [];
  const errors: string[] = [];
  const sanitize = (error: unknown) => String(error).replaceAll(token, "[fixture token]");
  page.on("pageerror", (error) => errors.push(sanitize(error)));
  page.on("websocket", (socket) => {
    const outstanding = new Map<string, (typeof requests)[number]>();
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type !== "req") {
        return;
      }
      const params = frame.method === "sessions.usage" ? frame.params : {};
      const record = {
        id: frame.id,
        method: frame.method,
        params,
        requestMs: performance.now(),
        bytes: Buffer.byteLength(payload),
      };
      requests.push(record);
      outstanding.set(frame.id, record);
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      const request = outstanding.get(frame.id);
      if (request) {
        outstanding.delete(frame.id);
        const response: WireResponse = {
          ...request,
          ms: performance.now() - request.requestMs,
          ok: frame.ok === true,
          bytes: Buffer.byteLength(payload),
          ...(!frame.ok ? { error: sanitize(frame.error?.message) } : {}),
          ...(request.method === "sessions.usage" && frame.ok
            ? { usage: projectResponse(frame.payload) }
            : {}),
        };
        responses.push(response);
        onResponse?.(response);
      }
      if (
        frame.type === "event" &&
        frame.event === "chat.metadata.changed" &&
        frame.payload?.agentId === USAGE_AGENT &&
        typeof frame.payload.usageUpdatedAt === "number"
      ) {
        events.push({
          name: frame.event,
          ms: performance.now(),
          usageUpdatedAt: frame.payload.usageUpdatedAt,
          failed: frame.payload.usageRefreshFailed === true,
        });
      }
    });
  });
  return { requests, responses, events, errors };
}

type View = {
  ms: number;
  badges: string[];
  partial: boolean;
  rowSummary: string;
  rows: Array<{ key: string; value: string; enabled: boolean }>;
};
type PageProbe = {
  click: number | null;
  clickEpoch: number | null;
  frames: View[];
  stop: () => void;
};
declare global {
  interface Window {
    usageOpenProbe?: PageProbe;
  }
}

async function armClick(page: Page, preset = false) {
  await page.evaluate((clickPreset) => {
    window.usageOpenProbe?.stop();
    const abort = new AbortController();
    let frameId = 0;
    const probe: PageProbe = {
      click: null,
      clickEpoch: null,
      frames: [],
      stop() {
        abort.abort();
        cancelAnimationFrame(frameId);
      },
    };
    window.usageOpenProbe = probe;
    document.addEventListener(
      "click",
      (e) => {
        if (
          !e.isTrusted ||
          !e
            .composedPath()
            .some((node) =>
              clickPreset
                ? node instanceof HTMLButtonElement &&
                  node.textContent.trim() === "30d" &&
                  Boolean(node.closest(".usage-presets"))
                : node instanceof HTMLAnchorElement && new URL(node.href).pathname === "/usage",
            )
        ) {
          return;
        }
        probe.click = performance.now();
        probe.clickEpoch = performance.timeOrigin + probe.click;
        let previous = "";
        const capture = () => {
          const usage = document.querySelector(".usage-page");
          if (usage?.getClientRects().length) {
            const badges = [...usage.querySelectorAll(".usage-metric-badge strong")].map((el) =>
              el.textContent.trim(),
            );
            const partial = Boolean(
              usage.querySelector('.usage-partial-notice:not([aria-hidden="true"])'),
            );
            const rowSummary =
              usage
                .querySelector(".sessions-card-header .sessions-card-count")
                ?.textContent.trim() ?? "";
            const rows = [
              ...usage.querySelectorAll<HTMLElement>(
                ".session-bars:not(.session-bars--selected) .session-bar-row",
              ),
            ].map((row) => {
              const button = row.querySelector<HTMLButtonElement>(".session-bar-selection");
              return {
                key: row.title,
                value: row.querySelector(".session-bar-value")?.textContent.trim() ?? "",
                enabled: Boolean(button && !button.disabled && button.getClientRects().length),
              };
            });
            const key = JSON.stringify([badges, partial, rowSummary, rows]);
            if (previous !== key) {
              probe.frames.push({
                ms: performance.now() - probe.click!,
                badges,
                partial,
                rowSummary,
                rows,
              });
              previous = key;
            }
          }
          frameId = requestAnimationFrame(capture);
        };
        frameId = requestAnimationFrame(capture);
      },
      { capture: true, signal: abort.signal },
    );
  }, preset);
}

function usageLink(page: Page) {
  return page.locator('a[href="/usage"]:visible').first();
}
function presetButton(page: Page, name: "7d" | "30d") {
  return page.locator(".usage-presets").getByRole("button", { name, exact: true });
}

async function selectAgent(page: Page) {
  const control = page.locator(".sessions-hub-header .agent-scope-control openclaw-agent-select");
  await control.getByRole("button", { name: "Agent" }).click();
  await page.getByText("Research", { exact: true }).filter({ visible: true }).last().click();
  await page.waitForFunction((agent) => {
    const picker = document.querySelector(
      ".sessions-hub-header .agent-scope-control openclaw-agent-select",
    ) as HTMLElement & { value?: string };
    return picker?.value === agent;
  }, USAGE_AGENT);
}

function badgeTokensMatch(label: string, tokens: number) {
  const match = /^(\d+(?:\.\d+)?)([KMB])?$/u.exec(label.replaceAll(",", ""));
  if (!match) {
    return false;
  }
  const factor = match[2] === "K" ? 1e3 : match[2] === "M" ? 1e6 : match[2] === "B" ? 1e9 : 1;
  const precision = match[1]!.split(".")[1]?.length ?? 0;
  return (
    Math.abs(Number(match[1]) * factor - tokens) <=
    (factor === 1 ? 0 : factor / 10 ** precision / 2 + 0.001)
  );
}

function verifyReport(response: WireResponse, truth: UsageTruth) {
  const p = response.params;
  assert.equal(p.agentId, USAGE_AGENT);
  assert.equal(p.startDate, truth.startDate);
  assert.equal(p.endDate, truth.endDate);
  assert.equal(p.groupBy, "family");
  assert.equal(p.sort, "cost");
  assert.equal(p.sortDirection, "desc");
  assert(response.ok, response.error ?? "Usage request failed");
  const report = response.usage!;
  assert.equal(report.partial, undefined, "Complete report must be labeled complete");
  assert.equal(report.cacheStatus?.status, "fresh", "Complete report must have fresh rollups");
  assert.equal(report.tokens, truth.tokens);
  assert.equal(report.cents, truth.cents);
  assert.equal(report.activeFamilies, truth.activeFamilies);
  assert.deepEqual(report.days, truth.dayTokens);
  assert.equal(
    report.rowsTotal,
    Math.floor((truth.families + 2) / 4),
    "Selected-agent roster count",
  );
  assert.equal(report.rows.length, Math.min(50, report.rowsTotal!));
  const expectedCosts = Object.values(truth.selectedRows)
    .map((s) => s.cents)
    .toSorted((a, b) => b - a)
    .slice(0, 50);
  assert.deepEqual(
    report.rows.map((row) => row.cents),
    expectedCosts,
  );
  for (const row of report.rows) {
    assert.equal(row.agentId, USAGE_AGENT);
    const expected = truth.selectedRows[row.key];
    assert(expected, "Unexpected top row: " + row.key);
    assert.equal(row.tokens, expected.tokens);
    assert.equal(row.label, expected.label);
  }
}

async function compare(base: string, head: string | undefined, outParent: string) {
  const lock = path.join(fixture, "active-benchmark");
  await mkdir(lock);
  try {
    await compareLocked(base, head, outParent);
  } finally {
    await rmdir(lock);
  }
}

async function compareLocked(base: string, head: string | undefined, outParent: string) {
  const matches = Number(values.pairs);
  const timeout = Number(values["deadline-ms"]);
  assert(Number.isSafeInteger(matches) && matches > 0 && timeout >= 1_000);
  const truth: UsageTruth = JSON.parse(await readFile(path.join(fixture, "truth.json"), "utf8"));
  assert.equal(
    truth.endDate,
    new Date().toISOString().slice(0, 10),
    "Fixture must use the default 30-day route range today (UTC)",
  );
  const sevenDay = {
    startDate: new Date(Date.parse(truth.endDate) - 6 * 86_400_000).toISOString().slice(0, 10),
    cents: 0,
    tokens: 0,
  };
  if (values.preset) {
    const ledger = await readFile(path.join(fixture, "bills.jsonl"), "utf8");
    for (const line of ledger.trimEnd().split("\n")) {
      const bill = JSON.parse(line);
      if (
        bill.agentId !== USAGE_AGENT ||
        bill.day < sevenDay.startDate ||
        bill.day > truth.endDate
      ) {
        continue;
      }
      sevenDay.cents += bill.cents;
      sevenDay.tokens += bill.tokens;
    }
  }
  const historyDiagnostic = values["foreground-history"]
    ? await import("./lib/usage-foreground-history.ts")
    : undefined;
  if (historyDiagnostic) {
    assert(
      truth.selectedRows[historyDiagnostic.FOREGROUND_HISTORY.sessionKey],
      "--foreground-history uses the original 6,000-family missing-rollup fixture",
    );
  }
  const historyPairs: Array<{
    sample: number;
    base?: ForegroundHistoryWindow;
    head?: ForegroundHistoryWindow;
  }> = historyDiagnostic ? Array.from({ length: matches }, (_, i) => ({ sample: i + 1 })) : [];
  const target = await build(base);
  const candidate = head ? await build(head) : undefined;
  const out = createControlUiE2eArtifactDir("usage-open", outParent);
  const roles: Array<{ role: "base" | "head"; build: typeof target }> = candidate
    ? [
        { role: "base", build: target },
        { role: "head", build: candidate },
      ]
    : [{ role: "base", build: target }];
  const stateDir = path.join(fixture, "state");
  const pristine = path.join(fixture, "pristine-state");
  if (!(await stat(pristine, { throwIfNoEntry: false }))) {
    await rename(stateDir, pristine);
  }
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  await writeFile(
    path.join(out, "manifest.json"),
    JSON.stringify(
      {
        builds: roles,
        fixture,
        fixtureIdentity: {
          truth: await hashFile(path.join(fixture, "truth.json")),
          billLedger: await hashFile(path.join(fixture, "bills.jsonl")),
        },
        samples: matches,
        browser: browser.version(),
        platform: process.platform,
        node: process.version,
        viewport: [1440, 900],
        timeout,
        processCold: true,
        browserCold: true,
        osCacheFlushed: false,
        ...(historyDiagnostic && { foregroundHistory: historyDiagnostic.FOREGROUND_HISTORY }),
      },
      null,
      2,
    ),
  );
  let failures = 0;
  try {
    for (let index = 0; index < matches; index++) {
      for (const item of index % 2 ? roles.toReversed() : roles) {
        const directory = path.join(out, item.role + "-" + (index + 1));
        await mkdir(directory);
        try {
          await runSample(item, index, directory);
        } catch (error) {
          failures++;
          console.error(
            item.role,
            index + 1,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  } finally {
    await browser.close();
  }
  if (historyDiagnostic) {
    const summary = historyDiagnostic.summarizeForegroundHistory(historyPairs);
    await writeFile(
      path.join(out, "foreground-history-summary.json"),
      JSON.stringify(summary, null, 2),
    );
    console.info(JSON.stringify({ foregroundHistory: summary }));
  }
  assert.equal(failures, 0, "See retained per-sample errors");

  async function runSample(item: (typeof roles)[number], index: number, directory: string) {
    // SQLite usage rollup keys contain the absolute physical database path.
    // Restore to precisely the seed path; the cloned database must not be relocated.
    await cp(pristine, stateDir, {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    });
    const home = path.join(directory, "home");
    await mkdir(home);
    const claim = await acquireGatewayE2ePortBlock();
    const token = randomUUID();
    const port = claim.port;
    const origin = "http://127.0.0.1:" + port;
    const configPath = path.join(home, "openclaw.json");
    const results: Array<Record<string, unknown>> = [];
    const started = Promise.withResolvers<ChildProcess>();
    const abort = new AbortController();
    let child: ChildProcess | undefined;
    let run: Promise<number> | undefined;
    let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    let page: Page | undefined;
    let wire: ReturnType<typeof watchWire> | undefined;
    let history:
      | Awaited<ReturnType<NonNullable<typeof historyDiagnostic>["openForegroundHistory"]>>
      | undefined;
    let shutdownLog = "";
    let drained = false;
    const log = createRedactingStreamWriter(
      {
        write(line) {
          shutdownLog += line;
          return true;
        },
      },
      [token],
    );
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          agents: {
            ownership: "explicit",
            entries: Object.fromEntries(
              Object.entries(USAGE_AGENTS).map(([id, name]) => [
                id,
                { name, workspace: path.join(fixture, "workspace") },
              ]),
            ),
          },
          browser: { enabled: false },
          discovery: { mdns: { mode: "off" } },
          update: { checkOnStart: false },
          plugins: { enabled: false },
          cron: { enabled: false },
          session: {
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
            maintenance: { mode: "warn", maxEntries: 20_000 },
          },
          gateway: {
            mode: "local",
            port,
            bind: "loopback",
            auth: { mode: "token", token },
            controlUi: { enabled: true, root: item.build.ui },
            tailscale: { mode: "off" },
          },
        }),
        { mode: 0o600 },
      );
      const stop = pathToFileURL(
        path.join(item.build.root, "scripts/lib/gateway-bench-stop-preload.mjs"),
      );
      stop.searchParams.set("parentPid", String(process.pid));
      stop.searchParams.set("entry", item.build.entry);
      run = runManagedCommand({
        bin: process.execPath,
        cwd: item.build.root,
        args: buildGatewayBenchChildArgs(
          item.build.entry,
          port,
          [
            "--import",
            path.join(item.build.root, "scripts/lib/gateway-bench-profile-preload.ts"),
            "--import",
            fileURLToPath(new URL("./lib/usage-bench-observer.mjs", import.meta.url)),
            "--import",
            stop.href,
          ],
          "token",
        ),
        env: createGatewayBenchEnv(home, configPath, {
          startupTrace: false,
          caseEnv: {
            OPENCLAW_STATE_DIR: stateDir,
            NODE_DISABLE_COMPILE_CACHE: "1",
            TZ: "UTC",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_USAGE_BENCH_COUNT_READS: "1",
          },
        }),
        signal: abort.signal,
        requireProcessTreeExit: true,
        timeoutMs: 2 * timeout + 180_000,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        onReady(p) {
          p.stdout!.on("data", log.write);
          p.stderr!.on("data", log.write);
          started.resolve(p);
        },
      });
      void run.then(
        (code) => started.reject(new Error("Gateway stopped before spawn: " + code)),
        started.reject,
      );
      child = await started.promise;
      const startAt = performance.now();
      const probe = await waitForInitialProbe({
        port,
        path: "/readyz",
        startAt,
        deadlineAt: startAt + 45_000,
        isDone: () => child!.exitCode !== null || child!.signalCode !== null,
      });
      assert.equal(probe.status, 200);
      context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
        locale: "en-US",
        timezoneId: "UTC",
        serviceWorkers: "block",
      });
      page = await context.newPage();
      page.setDefaultTimeout(12_000);
      if (historyDiagnostic) {
        history = await historyDiagnostic.openForegroundHistory(port, token);
      }
      wire = watchWire(
        page,
        token,
        history
          ? ({ method, params, usage, requestMs, ms }) => {
              if (
                method === "sessions.usage" &&
                params.agentId === USAGE_AGENT &&
                params.startDate === truth.startDate &&
                params.endDate === truth.endDate &&
                usage
              ) {
                history?.observe(usage.partial, requestMs + ms);
              }
            }
          : undefined,
      );
      // Match the existing Usage bench: tsx keepNames helpers must exist in evaluated probes.
      await page.addInitScript("globalThis.__name = (fn) => fn");
      await page.addInitScript(
        ({ key, value }) => {
          sessionStorage.setItem(key, value);
          localStorage.setItem(
            "openclaw:control-ui:community-invite:v2",
            JSON.stringify({ dismissedAtMs: Date.now() }),
          );
        },
        {
          key: CONTROL_UI_TOKEN_SESSION_KEY_PREFIX + gatewayOriginScope("ws://127.0.0.1:" + port),
          value: token,
        },
      );
      await page.goto(origin + "/sessions", { waitUntil: "domcontentloaded" });
      await selectAgent(page);
      await usageLink(page).waitFor();
      const documentOrigin = await page.evaluate(() => performance.timeOrigin);
      const phases = history
        ? (["cold"] as const)
        : values.preset
          ? (["cold", "warm", "preset"] as const)
          : (["cold", "warm"] as const);
      for (const phase of phases) {
        if (phase === "preset") {
          const first: number = wire.responses.length;
          await presetButton(page, "7d").click();
          await page.waitForFunction(
            (cost) =>
              document.querySelectorAll(".usage-metric-badge strong")[1]?.textContent.trim() ===
              cost,
            currency.format(sevenDay.cents / 100),
            { timeout },
          );
          assert(
            wire.responses
              .slice(first)
              .some(
                ({ params, usage }) =>
                  params.startDate === sevenDay.startDate &&
                  params.agentId === USAGE_AGENT &&
                  usage?.tokens === sevenDay.tokens &&
                  !usage.partial,
              ),
            "Missing exact 7d setup report",
          );
        }
        const counters = await observeCounters(child);
        const cpu = await readGatewayCpuUsage(child, { includeWorkers: true });
        const starts = {
          req: wire.requests.length,
          res: wire.responses.length,
          events: wire.events.length,
        };
        const expectedCost = currency.format(truth.cents / 100);
        const expectedActive = truth.activeFamilies.toLocaleString("en-US");
        const load = os.loadavg();
        await armClick(page, phase === "preset");
        if (phase === "cold") {
          history?.arm();
        }
        await (phase === "preset" ? presetButton(page, "30d") : usageLink(page)).click();
        const capture: JSHandle<View | false> = await page.waitForFunction<
          View | false,
          { cost: string; active: string; rowKeys: string[] }
        >(
          ({ cost, active, rowKeys }: { cost: string; active: string; rowKeys: string[] }) => {
            const samples = window.usageOpenProbe?.frames;
            return (
              samples?.find(
                (sample) =>
                  !sample.partial &&
                  sample.badges[1] === cost &&
                  sample.badges[2] === active &&
                  sample.rows.length &&
                  sample.rows.every((row) => row.enabled && rowKeys.includes(row.key)),
              ) || false
            );
          },
          { cost: expectedCost, active: expectedActive, rowKeys: Object.keys(truth.selectedRows) },
          { timeout },
        );
        const final: View | false = await capture.jsonValue();
        await capture.dispose();
        assert(final);
        const after = await readGatewayCpuUsage(child, { includeWorkers: true });
        const dispatches = (await observeCounters(child)).slice(counters.length);
        const observed: { frames: View[]; clickEpoch: number | null } = await page.evaluate(() => {
          window.usageOpenProbe?.stop();
          return {
            frames: window.usageOpenProbe?.frames ?? [],
            clickEpoch: window.usageOpenProbe?.clickEpoch ?? null,
          };
        });
        const frames: View[] = observed.frames;
        const clickEpoch: number | null = observed.clickEpoch;
        const requests = wire.requests.slice(starts.req);
        const firstUsageRequest = requests.find(
          (row) =>
            row.method === "sessions.usage" &&
            row.params.agentId === USAGE_AGENT &&
            row.params.startDate === truth.startDate &&
            row.params.endDate === truth.endDate,
        );
        const clickToRequestMs =
          clickEpoch !== null && firstUsageRequest
            ? performance.timeOrigin + firstUsageRequest.requestMs - clickEpoch
            : undefined;
        const responses = wire.responses.slice(starts.res);
        const reports = responses.filter((row) => row.method === "sessions.usage");
        const complete = reports.find(
          (row) => row.usage && !row.usage.partial && row.usage.tokens === truth.tokens,
        );
        const firstReport = reports.find((row) => row.usage && row.usage.tokens > 0);
        const firstTrusted: View | undefined = frames.find((frame) => {
          if (
            frame.badges[1] === expectedCost &&
            frame.badges[2] === expectedActive &&
            badgeTokensMatch(frame.badges[0] ?? "", truth.tokens) &&
            !frame.partial
          ) {
            return true;
          }
          return (
            frame.partial &&
            reports.some(
              (report) =>
                report.usage?.partial &&
                report.usage.tokens > 0 &&
                report.usage.tokens <= truth.tokens &&
                report.usage.cents <= truth.cents &&
                report.usage.activeFamilies !== undefined &&
                frame.badges[2] === report.usage.activeFamilies.toLocaleString("en-US") &&
                frame.badges[1] === currency.format(report.usage.cents / 100) &&
                badgeTokensMatch(frame.badges[0] ?? "", report.usage.tokens) &&
                Object.entries(report.usage.days).every(
                  ([day, tokens]) => tokens <= (truth.dayTokens[day] ?? 0),
                ),
            )
          );
        });
        const firstRows: View | undefined = frames.find((frame) =>
          frame.rows.some((row) => {
            const expected = truth.selectedRows[row.key];
            return (
              row.enabled &&
              expected &&
              (badgeTokensMatch(row.value, expected.tokens) ||
                (frame.partial &&
                  reports.some(
                    (report) =>
                      report.usage?.partial &&
                      report.usage.rows.some(
                        (available) =>
                          available.key === row.key &&
                          available.tokens !== undefined &&
                          available.tokens > 0 &&
                          available.tokens <= expected.tokens &&
                          badgeTokensMatch(row.value, available.tokens),
                      ),
                  )))
            );
          }),
        );
        assert(firstTrusted && firstRows, "No independently checked first data / rows frame");
        if (phase === "cold" && history) {
          await retainHistoryWindow(history);
        }
        results.push({
          phase,
          load,
          firstTrustedMs: firstTrusted?.ms,
          firstRowsMs: firstRows?.ms,
          finalMs: final.ms,
          clickToRequestMs,
          firstReportPartial: firstReport?.usage?.partial ?? null,
          requests,
          responses,
          publications: wire.events.slice(starts.events),
          frames,
          dispatches,
          gatewayCpu: measureGatewayCpuUsage(cpu, after),
        });
        await writeFile(path.join(directory, "result.json"), JSON.stringify({ results }, null, 2));
        assert(
          badgeTokensMatch(final.badges[0] ?? "", truth.tokens),
          "Rendered compact tokens mismatch: " + final.badges[0],
        );
        for (const row of final.rows) {
          assert(
            badgeTokensMatch(row.value, truth.selectedRows[row.key]!.tokens),
            "Rendered row tokens mismatch: " + row.key + " " + row.value,
          );
        }
        if (complete) {
          verifyReport(complete, truth);
        } else {
          assert(
            phase === "warm" && reports.length === 0,
            "No complete matching selected-agent response",
          );
        }
        assert.equal(wire.errors.length, 0, wire.errors.join("\n"));
        console.info(
          JSON.stringify({
            role: item.role,
            sample: index + 1,
            phase,
            firstTrustedMs: firstTrusted?.ms,
            firstRowsMs: firstRows?.ms,
            finalMs: final.ms,
            clickToRequestMs,
            sessionsUsage: requests.filter((r) => r.method === "sessions.usage").length,
            sessionsUsageResponses: reports.length,
            providerUsage: requests.filter((r) => r.method === "usage.status").length,
            dispatches: dispatches.length,
          }),
        );
        if (phase === "cold" && !history) {
          // Same-document history leaves the route without resetting browser or Gateway caches.
          await page.goBack({ waitUntil: "domcontentloaded" });
          await page.waitForURL("**/sessions");
          assert.equal(
            await page.evaluate(() => performance.timeOrigin),
            documentOrigin,
            "Warm revisit must use the same browser document",
          );
          await page.locator(".sessions-hub-header").waitFor();
          await page.locator(".usage-page").waitFor({ state: "hidden" });
        }
      }
      if (values.screenshots && index === 0) {
        const strip = page.locator(".usage-header-section .usage-summary-strip");
        // The shared frame helper depends on Vitest; this is the standalone Chromium driver.
        await strip.waitFor({ state: "visible" });
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        await page.screenshot({
          path: path.join(directory, "settled.png"),
          animations: "disabled",
        });
        const row = page
          .locator(".session-bars:not(.session-bars--selected) .session-bar-selection")
          .first();
        await row.scrollIntoViewIfNeeded();
        await row.click({ trial: true });
        await page.screenshot({ path: path.join(directory, "rows.png"), animations: "disabled" });
        await row.click();
        await page.waitForFunction(() =>
          Boolean(document.querySelector('.session-bar-selection[aria-pressed="true"]')),
        );
      }
    } catch (error) {
      const message = String(error).replaceAll(token, "[fixture token]");
      if (history && !historyPairs[index]?.[item.role]) {
        await retainHistoryWindow(history);
      }
      const frames = await page
        ?.evaluate(() => window.usageOpenProbe?.frames ?? [])
        .catch(() => []);
      await writeFile(
        path.join(directory, "failure.json"),
        JSON.stringify({ message, results, frames, wire }, null, 2),
      );
      if (page) {
        await page
          .screenshot({
            path: path.join(directory, "failure.png"),
            animations: "disabled",
            timeout: 3_000,
          })
          .catch(() => {});
      }
      throw new Error(message, { cause: error });
    } finally {
      await shutdown();
    }

    async function retainHistoryWindow(probe: NonNullable<typeof history>) {
      const window = await probe.finish();
      historyPairs[index]![item.role] = window;
      await writeFile(
        path.join(directory, "foreground-history.json"),
        JSON.stringify(window, null, 2),
      );
    }

    async function shutdown() {
      try {
        await history?.close();
        await context?.close();
        if (child) {
          await stopGatewayGracefully(child, 20_000);
        }
        if (run) {
          assert.equal(await run, 0, "Gateway clean shutdown");
        }
        drained = true;
      } catch (error) {
        abort.abort();
        await run?.catch(() => {});
        throw error;
      } finally {
        await claim.release();
        log.flush();
        await writeFile(path.join(directory, "gateway.log"), shutdownLog);
        if (drained) {
          await rename(stateDir, path.join(directory, "state"));
        }
      }
    }
  }
}

function observeCounters(child: ChildProcess) {
  return new Promise<
    Array<{ kind: string; rows: number; contextRows: number; packedBytes: number }>
  >((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", receive);
      reject(new Error("Timed out reading work counters"));
    }, 10_000);
    const receive = (value: unknown) => {
      const message = value as {
        channel?: string;
        action?: string;
        dispatches?: Parameters<typeof resolve>[0];
      };
      if (
        message?.channel !== "usage-volume-fixture" ||
        message.action !== "snapshot" ||
        !message.dispatches
      ) {
        return;
      }
      clearTimeout(timer);
      child.off("message", receive);
      resolve(message.dispatches);
    };
    child.on("message", receive);
    child.send({ channel: "usage-volume-fixture", action: "snapshot" });
  });
}
