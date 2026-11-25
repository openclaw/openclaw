// Synthetic loopback-only browser observation beside the canonical Team-shaped workload.
// node --import ./scripts/tsx.mjs scripts/perf/current-work-refetch-browser.mjs --url http://127.0.0.1:41471 --output .local/current-work-browser-base --label base
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../../ui/src/test-helpers/control-ui-e2e-context.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    output: { type: "string" },
    label: { type: "string", default: "arm" },
    "duration-ms": { type: "string", default: "600000" },
  },
});
assert(values.url && values.output, "--url and --output required");
const url = new URL(values.url);
assert(
  url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) >= 40000,
  "Only an explicitly supplied synthetic loopback Gateway on port >=40000 is permitted",
);
const durationMs = Number(values["duration-ms"]);
assert(Number.isSafeInteger(durationMs) && durationMs >= 1000);
const artifactDir = createControlUiE2eArtifactDir(
  `current-work-refetch-${values.label}`,
  values.output,
);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "en-US",
  serviceWorkers: "block",
});
const page = await context.newPage();
page.setDefaultTimeout(60000);
let phase = "bootstrap";
let startedAt;
let latestEvent;
let connections = 0;
let expectedReconnect = false;
const requests = [];
const events = {};
const errors = [];
const samples = [];
const assertions = [];
const phaseIntervals = [];
const pending = new Map();
const proofKey = "agent:main:current-work-refetch-browser-proof";
const mark = (next) => {
  const now = Date.now();
  const previous = phaseIntervals.at(-1);
  if (previous) {
    previous.endedAt = now;
  }
  phase = next;
  phaseIntervals.push({ phase, startedAt: now });
  console.log(JSON.stringify({ phase, elapsedMs: startedAt ? now - startedAt : null }));
};
const rpc = (method, params) =>
  evaluateControlUiContext(
    page,
    (app, arg) => app.gateway.snapshot.client.request(arg.method, arg.params),
    { method, params },
  );
const navigate = (route, search = "") =>
  evaluateControlUiContext(page, (app, arg) => app.navigate(arg.route, { search: arg.search }), {
    route,
    search,
  });
const ready = () =>
  page.waitForFunction(() => window.openclawControlUi?.snapshot().gatewayPhase === "connected");
const report = (outcome, failure) => {
  const totals = {};
  const minuteCounts = {};
  for (const request of requests) {
    const key = `${request.phase}:${request.owner}`;
    totals[key] = (totals[key] ?? 0) + 1;
    if (request.measured) {
      const minute = Math.floor(request.elapsedMs / 60000);
      const minuteKey = `${minute}:${request.phase}:${request.owner}`;
      minuteCounts[minuteKey] = (minuteCounts[minuteKey] ?? 0) + 1;
    }
  }
  const body = {
    label: values.label,
    url: url.origin,
    artifactDir,
    durationMs,
    smoke: durationMs < 600000,
    startedAt,
    endedAt: Date.now(),
    outcome,
    failure,
    connections,
    expectedReconnect,
    totals,
    minuteCounts,
    phaseIntervals,
    events,
    requests,
    samples,
    assertions,
    errors,
  };
  writeFileSync(path.join(artifactDir, "report.json"), JSON.stringify(body, null, 2));
  return body;
};

await page.addInitScript("globalThis.__name = (fn) => fn");
await context.addInitScript(() => {
  const Native = window.WebSocket;
  window.currentWorkRefetchSockets = [];
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      window.currentWorkRefetchSockets.push(this);
    }
  };
});
page.on("pageerror", (error) => errors.push({ phase, message: error.message }));
page.on("websocket", (socket) => {
  connections += 1;
  socket.on("framesent", ({ payload }) => {
    let frame;
    try {
      frame = JSON.parse(payload.toString());
    } catch {
      return;
    }
    if (frame.type !== "req" || frame.method !== "sessions.list") {
      return;
    }
    const params = frame.params ?? {};
    const owner = params.activeOnly
      ? "current-work"
      : params.includeActivitySummary
        ? "history"
        : params.includeOwnerSessionCounts
          ? "sidebar-owner-counts"
          : (params.source ?? "unattributed");
    const request = {
      id: frame.id,
      phase,
      owner,
      params,
      at: Date.now(),
      elapsedMs: startedAt ? Date.now() - startedAt : null,
      measured: Boolean(startedAt && Date.now() - startedAt < durationMs),
      latestEvent,
    };
    requests.push(request);
    pending.set(frame.id, request);
  });
  socket.on("framereceived", ({ payload }) => {
    let frame;
    try {
      frame = JSON.parse(payload.toString());
    } catch {
      return;
    }
    if (
      frame.type === "event" &&
      ["sessions.changed", "sessions.processes.changed", "presence"].includes(frame.event)
    ) {
      const reason = frame.payload?.reason ?? "unspecified";
      const key = `${frame.event}:${reason}`;
      events[key] = (events[key] ?? 0) + 1;
      latestEvent = { event: frame.event, reason, at: Date.now() };
    }
    if (frame.type === "res" && pending.has(frame.id)) {
      const request = pending.get(frame.id);
      pending.delete(frame.id);
      Object.assign(request, {
        latencyMs: Date.now() - request.at,
        ok: frame.ok,
        count: frame.payload?.sessions?.length,
        rowsUnchanged: frame.payload?.rowsUnchanged,
        error: frame.error,
      });
    }
  });
});

try {
  mark("bootstrap");
  assert.equal((await page.goto(new URL("activity?view=live", url).href)).status(), 200);
  await ready();
  await page.locator(".activity-current-work").waitFor();
  await rpc("sessions.create", {
    agentId: "main",
    key: proofKey,
    label: "Current Work initial proof",
  });
  const sidebarRow = page
    .locator("openclaw-app-sidebar")
    .locator(`[data-session-key="${proofKey}"]`)
    .first();
  await sidebarRow.waitFor();
  await page.screenshot({ path: path.join(artifactDir, "initial.png") });
  startedAt = Date.now();
  mark("steady-current-work");
  let iteration = 0;
  let navigated = false;
  let reconnected = false;
  let minute = -1;
  while (Date.now() - startedAt < durationMs) {
    const elapsed = Date.now() - startedAt;
    if (!navigated && elapsed >= durationMs * 0.3) {
      navigated = true;
      mark("history-navigation");
      await navigate("activity");
      await delay(2000);
      mark("history-search");
      await navigate("activity", "?q=Current Work");
      await delay(3000);
      mark("sessions-navigation");
      await navigate("sessions");
      await page.locator("openclaw-sessions-page").waitFor();
      await delay(3000);
      mark("return-current-work");
      await navigate("activity", "?view=live");
      await page.locator(".activity-current-work").waitFor();
      await delay(3000);
      mark("steady-current-work");
    }
    if (!reconnected && elapsed >= durationMs * 0.52) {
      reconnected = true;
      expectedReconnect = true;
      mark("reconnect");
      const before = connections;
      const socketCount = await page.evaluate(() => {
        for (const socket of window.currentWorkRefetchSockets) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(4000, "Synthetic current-work-refetch reconnect");
          }
        }
        return window.currentWorkRefetchSockets.length;
      });
      await page.waitForFunction(
        (count) => window.currentWorkRefetchSockets.length > count,
        socketCount,
      );
      assert(connections > before, "Browser must create a new socket after intentional reconnect");
      await ready();
      await page.locator(".activity-current-work").waitFor();
      await delay(3000);
      assertions.push({ kind: "reconnect", connections });
      mark("steady-current-work");
    }
    const label = `Current Work live revision ${++iteration}`;
    await rpc("sessions.patch", { key: proofKey, label });
    samples.push({
      at: Date.now(),
      elapsedMs: Date.now() - startedAt,
      currentWorkRows: await page.locator(".activity-current-work__row").count(),
      sidebarText: await sidebarRow.textContent(),
    });
    const currentMinute = Math.floor((Date.now() - startedAt) / 60000);
    if (currentMinute !== minute) {
      minute = currentMinute;
      report("running");
      console.log(
        JSON.stringify({
          minute,
          listCalls: requests.length,
          connections,
          events: Object.values(events).reduce((a, b) => a + b, 0),
        }),
      );
    }
    await delay(Math.min(10000, Math.max(0, durationMs - (Date.now() - startedAt))));
  }
  mark("final-burst-verification");
  for (let revision = 0; revision < 24; revision++) {
    await rpc("sessions.patch", {
      key: proofKey,
      label: `Current Work final revision ${revision}`,
    });
  }
  await page.waitForFunction(
    ({ key, label }) => {
      const rows = [...document.querySelectorAll("openclaw-app-sidebar [data-session-key]")];
      return rows.some(
        (row) => row.getAttribute("data-session-key") === key && row.textContent.includes(label),
      );
    },
    { key: proofKey, label: "Current Work final revision 23" },
  );
  const authoritative = await rpc("sessions.describe", { key: proofKey, agentId: "main" });
  assert.equal(authoritative.session?.label, "Current Work final revision 23");
  assert((await sidebarRow.textContent()).includes(authoritative.session.label));
  assert.equal(
    await page.locator(`.activity-current-work__row[data-session-key="${proofKey}"]`).count(),
    0,
    "Inactive synthetic row must not leak into Current Work after changes",
  );
  assertions.push({
    kind: "final-sidebar-burst",
    patches: 24,
    authoritativeLabel: authoritative.session.label,
    renderedLabel: await sidebarRow.textContent(),
    inactiveCurrentWorkExcluded: true,
  });
  await page.screenshot({ path: path.join(artifactDir, "final.png") });
  const final = report("passed");
  console.log(
    JSON.stringify({
      outcome: final.outcome,
      report: path.join(artifactDir, "report.json"),
      totals: final.totals,
      assertions,
    }),
  );
} catch (error) {
  await page.screenshot({ path: path.join(artifactDir, "failure.png") }).catch(() => {});
  report("failed", error.stack ?? String(error));
  throw error;
} finally {
  await context.close();
  await browser.close();
}
