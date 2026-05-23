import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";
import { testing as browserToolActionTesting } from "../browser-tool.actions.js";
import { createBrowserTool, testing as browserToolTesting } from "../browser-tool.js";
import {
  closeChromeMcpTab,
  emulateChromeMcpPage,
  evaluateChromeMcpScript,
  getChromeMcpConsoleMessage,
  getChromeMcpNetworkRequest,
  getChromeMcpTabId,
  getChromeMcpHeapSnapshotSummary,
  listChromeMcpConsoleMessages,
  listChromeMcpExtensions,
  listChromeMcpNetworkRequests,
  openChromeMcpTab,
  resetChromeMcpSessionsForTest,
  runChromeMcpLighthouseAudit,
  startChromeMcpPerformanceTrace,
  startChromeMcpScreencast,
  stopChromeMcpPerformanceTrace,
  stopChromeMcpScreencast,
  takeChromeMcpHeapSnapshot,
  takeChromeMcpSnapshot,
  waitForChromeMcpText,
  type ChromeMcpProfileOptions,
} from "./chrome-mcp.js";
import type { ResolvedBrowserConfig } from "./config.js";
import { createBrowserRouteDispatcher } from "./routes/dispatcher.js";
import type { BrowserDispatchRequest } from "./routes/dispatcher.js";
import { createBrowserRouteContext } from "./server-context.js";
import type { BrowserServerState } from "./server-context.js";

const CHROME_BIN = process.env.OPENCLAW_LIVE_BROWSER_CHROME_BIN?.trim() || "/usr/bin/google-chrome";
const LIVE = isLiveTestEnabled(["OPENCLAW_BROWSER_CHROME_MCP_LIVE_TEST"]) && existsSync(CHROME_BIN);
const describeLive = LIVE ? describe : describe.skip;

type LiveFixture = {
  cdpPort: number;
  chrome: ChildProcessWithoutNullStreams;
  httpPort: number;
  httpServer: Server;
  root: string;
};

function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitForJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      last = new Error(`${response.status} ${response.statusText}`);
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw last instanceof Error ? last : new Error(`timed out waiting for ${url}`);
}

function rosterFixtureHtml(): string {
  return `<!doctype html>
<html>
<head>
  <title>OpenClaw New Recruit-style roster fixture</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f6f6f1; }
    header, main { padding: 16px; }
    header { display: flex; gap: 12px; align-items: center; border-bottom: 1px solid #ccc; background: white; }
    button, input, select { font: inherit; margin: 4px; padding: 6px; }
    .builder { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .panel, .unit-card, .summary { background: white; border: 1px solid #bbb; border-radius: 6px; padding: 12px; }
    .unit-card { margin-top: 12px; }
    .hidden { display: none; }
    .valid { color: #146c2e; font-weight: 700; }
  </style>
</head>
<body>
  <header>
    <strong>New Recruit-style Roster Fixture</strong>
    <button id="create-list">Create List</button>
    <input id="list-name" aria-label="List name" placeholder="Search list by name...">
    <select id="game-system" aria-label="Game system">
      <option>Warhammer 40,000 10th Edition</option>
      <option>Age of Sigmar</option>
    </select>
  </header>
  <main>
    <section id="builder" class="builder hidden" aria-label="Roster builder">
      <div class="panel">
        <label>Faction
          <select id="faction" aria-label="Faction">
            <option value="Adeptus Astartes">Adeptus Astartes</option>
            <option value="Tyranids">Tyranids</option>
          </select>
        </label>
        <label>Detachment
          <select id="detachment" aria-label="Detachment">
            <option>Invasion Fleet</option>
            <option>Crusher Stampede</option>
            <option>Vanguard Onslaught</option>
          </select>
        </label>
        <input id="unit-search" aria-label="Unit search" placeholder="Search units">
        <button id="add-termagants">Add Termagants</button>
        <button id="add-tyrant">Add Hive Tyrant</button>
      </div>
      <div class="panel" aria-label="Roster units">
        <div id="empty-state">No units selected.</div>
        <div id="termagants-card" class="unit-card hidden" draggable="true" role="button" tabindex="0" aria-label="Termagants unit card">
          <h2>Termagants</h2>
          <label>Models
            <input id="termagants-count" aria-label="Termagants model count" inputmode="numeric" value="10">
          </label>
          <button id="termagants-plus" aria-label="Increase Termagants model count">+5 models</button>
          <label>Weapon loadout
            <select id="termagants-weapon" aria-label="Termagants weapon loadout">
              <option>Fleshborers</option>
              <option>Devourers</option>
              <option>Spinefists</option>
            </select>
          </label>
          <label><input id="termagants-enhancement" aria-label="Adaptive Biology enhancement" type="checkbox"> Adaptive Biology enhancement</label>
        </div>
        <div id="leader-drop" class="unit-card" role="button" tabindex="0" aria-label="Leader attachment drop zone">Attach leader here</div>
      </div>
    </section>
    <aside class="summary" aria-live="polite">
      <h2>Roster Summary</h2>
      <p id="summary-line">No roster yet.</p>
      <p id="points-line">0 pts</p>
      <p id="valid-line" class="valid">Waiting for units</p>
    </aside>
    <script>
      const state = { created: false, faction: 'Adeptus Astartes', detachment: 'Invasion Fleet', hasTermagants: false, count: 10, weapon: 'Fleshborers', enhancement: false, leaderAttached: false };
      const $ = (id) => document.getElementById(id);
      const render = () => {
        $('builder').classList.toggle('hidden', !state.created);
        $('empty-state').classList.toggle('hidden', state.hasTermagants);
        $('termagants-card').classList.toggle('hidden', !state.hasTermagants);
        const unitLine = state.hasTermagants ? 'Termagants x' + state.count + ' with ' + state.weapon : 'No units selected';
        const enhancement = state.enhancement ? ' + Adaptive Biology enhancement' : '';
        const leader = state.leaderAttached ? ' + leader attached' : '';
        const points = state.hasTermagants ? 60 + Math.max(0, state.count - 10) * 6 + (state.weapon === 'Devourers' ? 10 : 0) + (state.enhancement ? 25 : 0) + (state.leaderAttached ? 80 : 0) : 0;
        $('summary-line').textContent = state.faction + ' / ' + state.detachment + ': ' + unitLine + enhancement + leader;
        $('points-line').textContent = points + ' pts';
        $('valid-line').textContent = state.hasTermagants && state.count >= 10 ? 'Roster valid' : 'Waiting for units';
        window.__openclawRosterFixture = { ...state, points, summary: $('summary-line').textContent, valid: $('valid-line').textContent };
      };
      $('create-list').addEventListener('click', () => { state.created = true; render(); });
      $('list-name').addEventListener('input', (event) => { state.listName = event.target.value; render(); });
      $('faction').addEventListener('change', (event) => { state.faction = event.target.value; render(); });
      $('detachment').addEventListener('change', (event) => { state.detachment = event.target.value; render(); });
      $('unit-search').addEventListener('input', (event) => { state.search = event.target.value; render(); });
      $('add-termagants').addEventListener('click', () => { state.hasTermagants = true; render(); });
      $('termagants-count').addEventListener('input', (event) => { state.count = Number(event.target.value || '0'); render(); });
      $('termagants-plus').addEventListener('click', () => { state.count += 5; $('termagants-count').value = String(state.count); render(); });
      $('termagants-weapon').addEventListener('change', (event) => { state.weapon = event.target.value; render(); });
      $('termagants-enhancement').addEventListener('change', (event) => { state.enhancement = event.target.checked; render(); });
      $('termagants-card').addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', 'Termagants'); });
      $('leader-drop').addEventListener('dragover', (event) => event.preventDefault());
      $('leader-drop').addEventListener('drop', (event) => { event.preventDefault(); state.leaderAttached = true; render(); });
      console.log('openclaw-roster-fixture-ready');
      render();
    </script>
  </main>
</body>
</html>`;
}

async function startFixture(): Promise<LiveFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-mcp-live-"));
  const profileDir = path.join(root, "profile");
  const outDir = path.join(root, "out");
  await mkdir(outDir, { recursive: true });

  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/data.json") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ ok: true, source: "openclaw-live-fixture" }));
      return;
    }
    if (url.pathname === "/roster") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/html",
      });
      response.end(rosterFixtureHtml());
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html",
    });
    response.end(`<!doctype html>
<html>
<head><title>OpenClaw Chrome MCP live fixture</title></head>
<body>
  <main>
    <h1>OpenClaw Chrome MCP live fixture</h1>
    <button id="action">Action</button>
    <form><label>Name <input id="name" aria-label="Name"></label></form>
    <script>
      console.log('openclaw-live-fixture-console-ready');
      window.__openclawFixture = { ready: true };
      fetch('/api/data.json').then(r => r.json()).then(data => {
        window.__openclawFixture.api = data;
        console.log('openclaw-live-fixture-fetch-ready', data.ok);
      });
    </script>
  </main>
</body>
</html>`);
  });
  const httpPort = await listen(httpServer);

  const cdpProbeServer = createServer();
  const cdpPort = await listen(cdpProbeServer);
  await closeServer(cdpProbeServer);

  const chrome = spawn(
    CHROME_BIN,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-extensions",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--metrics-recording-only",
      "--disable-features=MediaRouter,OptimizationHints,Translate,AutofillServerCommunication,InterestFeedContentSuggestions,PrivacySandboxSettings4,SignInPromo",
      "--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE 127.0.0.1",
      "--disable-gpu",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${cdpPort}`,
      `http://127.0.0.1:${httpPort}/`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`, 20_000);
  return { cdpPort, chrome, httpPort, httpServer, root };
}

async function stopFixture(fixture: LiveFixture): Promise<void> {
  await resetChromeMcpSessionsForTest().catch(() => {});
  fixture.chrome.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (fixture.chrome.exitCode === null) {
    fixture.chrome.kill("SIGKILL");
  }
  await closeServer(fixture.httpServer).catch(() => {});
  await rm(fixture.root, { recursive: true, force: true });
}

async function optionalChromeMcpTool<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Tool .+ not found/.test(message)) {
      return undefined;
    }
    throw err;
  }
}

function createLiveBrowserConfig(profileName: string, fixture: LiveFixture): ResolvedBrowserConfig {
  return {
    enabled: true,
    evaluateEnabled: true,
    controlPort: 18791,
    cdpPortRangeStart: 18800,
    cdpPortRangeEnd: 18850,
    cdpProtocol: "http",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    remoteCdpTimeoutMs: 10_000,
    remoteCdpHandshakeTimeoutMs: 10_000,
    localLaunchTimeoutMs: 10_000,
    localCdpReadyTimeoutMs: 10_000,
    actionTimeoutMs: 30_000,
    color: "#00AA00",
    headless: true,
    headlessSource: "default",
    noSandbox: false,
    attachOnly: true,
    defaultProfile: profileName,
    profiles: {
      [profileName]: {
        driver: "existing-session",
        cdpUrl: `http://127.0.0.1:${fixture.cdpPort}`,
        color: "#00AA00",
      },
    },
    tabCleanup: { enabled: false, idleMinutes: 0, maxTabsPerSession: 0, sweepMinutes: 0 },
    ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
    extraArgs: [],
  };
}

function createLiveRouteJson(profileName: string, fixture: LiveFixture) {
  const state: BrowserServerState = {
    port: 0,
    resolved: createLiveBrowserConfig(profileName, fixture),
    profiles: new Map(),
  };
  const ctx = createBrowserRouteContext({ getState: () => state });
  const dispatcher = createBrowserRouteDispatcher(ctx);
  return async (
    _baseUrl: string | undefined,
    req: {
      method: BrowserDispatchRequest["method"];
      path: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      timeoutMs?: number;
    },
  ) => {
    const response = await dispatcher.dispatch({
      method: req.method,
      path: req.path,
      query: req.query,
      body: req.body,
    });
    if (response.status >= 400) {
      throw new Error(JSON.stringify(response.body));
    }
    return response.body;
  };
}

async function executeBrowserToolAction(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await createBrowserTool({ allowHostControl: true }).execute("live", args);
  return result.details as Record<string, unknown>;
}

type SnapshotNode = {
  id?: string;
  role?: string;
  name?: string;
  uid?: string;
  children?: SnapshotNode[];
};

function findSnapshotUid(
  node: SnapshotNode,
  params: { role?: string; nameIncludes: string },
): string {
  for (const allowRoleFallback of [false, true]) {
    const stack = [node];
    while (stack.length) {
      const current = stack.shift()!;
      const roleMatches = allowRoleFallback || !params.role || current.role === params.role;
      const nameMatches = String(current.name ?? "").includes(params.nameIncludes);
      const ref = current.uid ?? current.id;
      if (roleMatches && nameMatches && ref) {
        return ref;
      }
      stack.push(...(current.children ?? []));
    }
  }
  throw new Error(`snapshot uid not found for ${params.role ?? "any"}:${params.nameIncludes}`);
}

async function snapshotUid(params: {
  profileName: string;
  profile: ChromeMcpProfileOptions;
  targetId: string;
  role?: string;
  nameIncludes: string;
}): Promise<string> {
  const snapshot = (await takeChromeMcpSnapshot({
    profileName: params.profileName,
    profile: params.profile,
    targetId: params.targetId,
  })) as SnapshotNode;
  return findSnapshotUid(snapshot, params);
}

describeLive("browser (live): Chrome MCP isolated local fixture", () => {
  it(
    "proves route-backed Chrome MCP diagnostics against a temporary browser",
    { timeout: 180_000 },
    async () => {
      const fixture = await startFixture();
      const profileName = `live-fixture-${Date.now()}`;
      const profile: ChromeMcpProfileOptions = { cdpUrl: `http://127.0.0.1:${fixture.cdpPort}` };
      let targetId: string | undefined;
      try {
        const tab = await openChromeMcpTab(
          profileName,
          `http://127.0.0.1:${fixture.httpPort}/`,
          profile,
        );
        targetId = tab.targetId;
        await waitForChromeMcpText({
          profileName,
          profile,
          targetId,
          text: ["OpenClaw Chrome MCP live fixture"],
          timeoutMs: 10_000,
        });

        await expect(
          evaluateChromeMcpScript({
            profileName,
            profile,
            targetId,
            fn: "() => window.__openclawFixture?.ready === true",
          }),
        ).resolves.toBe(true);

        await emulateChromeMcpPage({ profileName, profile, targetId, colorScheme: "dark" });
        await expect(
          evaluateChromeMcpScript({
            profileName,
            profile,
            targetId,
            fn: '() => matchMedia("(prefers-color-scheme: dark)").matches',
          }),
        ).resolves.toBe(true);

        const consoleMessages = await listChromeMcpConsoleMessages({
          profileName,
          profile,
          targetId,
          includePreservedMessages: true,
          pageSize: 20,
        });
        const consoleHit = consoleMessages.messages.find((message) =>
          String(message.text ?? "").includes("openclaw-live-fixture"),
        );
        expect(consoleHit).toBeDefined();
        if (consoleHit?.id !== undefined) {
          await expect(
            getChromeMcpConsoleMessage({ profileName, profile, targetId, msgid: consoleHit.id }),
          ).resolves.toEqual(
            expect.objectContaining({ text: expect.stringContaining("openclaw-live-fixture") }),
          );
        }

        const networkRequests = await listChromeMcpNetworkRequests({
          profileName,
          profile,
          targetId,
          includePreservedRequests: true,
          pageSize: 50,
        });
        const networkHit = networkRequests.requests.find((request) =>
          String(request.url ?? "").includes("/api/data.json"),
        );
        expect(networkHit).toEqual(expect.objectContaining({ status: "200" }));
        const requestId =
          typeof networkHit?.requestId === "number" ? networkHit.requestId : Number(networkHit?.id);
        expect(Number.isFinite(requestId)).toBe(true);
        await expect(
          getChromeMcpNetworkRequest({ profileName, profile, targetId, reqid: requestId }),
        ).resolves.toEqual(
          expect.objectContaining({
            responseBody: expect.stringContaining("openclaw-live-fixture"),
            status: "200",
          }),
        );

        const traceFile = path.join(fixture.root, "out", "trace.json");
        await expect(
          startChromeMcpPerformanceTrace({
            profileName,
            profile,
            targetId,
            filePath: traceFile,
            timeoutMs: 15_000,
          }),
        ).resolves.toContain("performance trace");
        await evaluateChromeMcpScript({
          profileName,
          profile,
          targetId,
          fn: "() => { for (let i = 0; i < 1000; i++) Math.sqrt(i); return true; }",
        });
        await expect(
          stopChromeMcpPerformanceTrace({
            profileName,
            profile,
            targetId,
            filePath: traceFile,
            timeoutMs: 20_000,
          }),
        ).resolves.toContain("trace");

        await expect(
          runChromeMcpLighthouseAudit({
            profileName,
            profile,
            targetId,
            mode: "snapshot",
            device: "desktop",
            outputDirPath: path.join(fixture.root, "out"),
            timeoutMs: 60_000,
          }),
        ).resolves.toEqual(
          expect.objectContaining({ output: expect.stringContaining("Lighthouse") }),
        );

        await expect(
          startChromeMcpScreencast({
            profileName,
            profile,
            targetId,
            filePath: path.join(fixture.root, "out", "screencast.webm"),
            timeoutMs: 15_000,
          }),
        ).resolves.toContain("Screencast recording started");
        await expect(
          stopChromeMcpScreencast({ profileName, profile, targetId, timeoutMs: 15_000 }),
        ).resolves.toContain("screencast");

        await expect(
          getChromeMcpTabId({ profileName, profile, targetId, timeoutMs: 10_000 }),
        ).resolves.toEqual(expect.any(String));

        const heapFile = path.join(fixture.root, "out", "heap.heapsnapshot");
        const heapResult = await optionalChromeMcpTool(async () => {
          await takeChromeMcpHeapSnapshot({
            profileName,
            profile,
            targetId: targetId ?? "",
            filePath: heapFile,
            timeoutMs: 30_000,
          });
          return await getChromeMcpHeapSnapshotSummary({
            profileName,
            profile,
            filePath: heapFile,
            timeoutMs: 30_000,
          });
        });
        if (heapResult) {
          expect(heapResult.output).not.toBe("");
        }

        const extensions = await optionalChromeMcpTool(async () =>
          listChromeMcpExtensions({ profileName, profile, timeoutMs: 10_000 }),
        );
        if (extensions) {
          expect(Array.isArray(extensions)).toBe(true);
        }
      } finally {
        if (targetId) {
          await closeChromeMcpTab(profileName, targetId, profile).catch(() => {});
        }
        await stopFixture(fixture);
      }
    },
  );

  it(
    "proves Browser tool actions through the Chrome MCP route dispatcher",
    { timeout: 180_000 },
    async () => {
      const fixture = await startFixture();
      const profileName = "chrome-live";
      const profile: ChromeMcpProfileOptions = { cdpUrl: `http://127.0.0.1:${fixture.cdpPort}` };
      let targetId: string | undefined;
      try {
        browserToolTesting.setDepsForTest({
          browserRouteJson: createLiveRouteJson(profileName, fixture),
          getRuntimeConfig: () => ({ browser: createLiveBrowserConfig(profileName, fixture) }),
        });
        const tab = await openChromeMcpTab(
          profileName,
          `http://127.0.0.1:${fixture.httpPort}/`,
          profile,
        );
        targetId = tab.targetId;
        await waitForChromeMcpText({
          profileName,
          profile,
          targetId,
          text: ["OpenClaw Chrome MCP live fixture"],
          timeoutMs: 10_000,
        });

        const consoleMessages = await listChromeMcpConsoleMessages({
          profileName,
          profile,
          targetId,
          includePreservedMessages: true,
          pageSize: 20,
        });
        const consoleHit = consoleMessages.messages.find((message) =>
          String(message.text ?? "").includes("openclaw-live-fixture"),
        );
        expect(consoleHit?.id).toEqual(expect.any(Number));

        const consoleDetail = await executeBrowserToolAction({
          action: "console-message",
          profile: profileName,
          targetId,
          msgid: consoleHit?.id,
        });
        expect(consoleDetail).toEqual(
          expect.objectContaining({
            ok: true,
            message: expect.objectContaining({
              text: expect.stringContaining("openclaw-live-fixture"),
            }),
          }),
        );

        const networkRequests = await listChromeMcpNetworkRequests({
          profileName,
          profile,
          targetId,
          includePreservedRequests: true,
          pageSize: 50,
        });
        const networkHit = networkRequests.requests.find((request) =>
          String(request.url ?? "").includes("/api/data.json"),
        );
        const requestId =
          typeof networkHit?.requestId === "number" ? networkHit.requestId : Number(networkHit?.id);
        expect(Number.isFinite(requestId)).toBe(true);

        const requestDetail = await executeBrowserToolAction({
          action: "request-detail",
          profile: profileName,
          targetId,
          reqid: requestId,
        });
        expect(requestDetail).toEqual(
          expect.objectContaining({
            ok: true,
            request: expect.objectContaining({
              responseBody: expect.stringContaining("openclaw-live-fixture"),
              status: "200",
            }),
          }),
        );

        await expect(
          executeBrowserToolAction({
            action: "emulate",
            operation: "media",
            profile: profileName,
            targetId,
            colorScheme: "dark",
          }),
        ).resolves.toEqual(expect.objectContaining({ ok: true }));
        await expect(
          evaluateChromeMcpScript({
            profileName,
            profile,
            targetId,
            fn: '() => matchMedia("(prefers-color-scheme: dark)").matches',
          }),
        ).resolves.toBe(true);

        await expect(
          executeBrowserToolAction({
            action: "trace",
            operation: "start",
            profile: profileName,
            targetId,
          }),
        ).resolves.toEqual(expect.objectContaining({ ok: true, traceFormat: "chrome-devtools" }));
        await evaluateChromeMcpScript({
          profileName,
          profile,
          targetId,
          fn: "() => { for (let i = 0; i < 1000; i++) Math.sqrt(i); return true; }",
        });
        await expect(
          executeBrowserToolAction({
            action: "trace",
            operation: "stop",
            profile: profileName,
            targetId,
          }),
        ).resolves.toEqual(expect.objectContaining({ ok: true, traceFormat: "chrome-devtools" }));

        await expect(
          executeBrowserToolAction({
            action: "lighthouse",
            profile: profileName,
            targetId,
            mode: "snapshot",
            device: "desktop",
            outputDirPath: path.join(fixture.root, "out"),
            timeoutMs: 60_000,
          }),
        ).resolves.toEqual(
          expect.objectContaining({ ok: true, output: expect.stringContaining("Lighthouse") }),
        );

        await expect(
          executeBrowserToolAction({
            action: "screencast",
            operation: "start",
            profile: profileName,
            targetId,
            timeoutMs: 15_000,
          }),
        ).resolves.toEqual(
          expect.objectContaining({ ok: true, output: expect.stringContaining("Screencast") }),
        );
        await expect(
          executeBrowserToolAction({
            action: "screencast",
            operation: "stop",
            profile: profileName,
            targetId,
            timeoutMs: 15_000,
          }),
        ).resolves.toEqual(
          expect.objectContaining({ ok: true, output: expect.stringContaining("screencast") }),
        );
      } finally {
        browserToolTesting.setDepsForTest(null);
        if (targetId) {
          await closeChromeMcpTab(profileName, targetId, profile).catch(() => {});
        }
        await stopFixture(fixture);
      }
    },
  );

  it(
    "proves New Recruit-style roster interactions through Chrome MCP Browser tool actions",
    { timeout: 180_000 },
    async () => {
      const fixture = await startFixture();
      const profileName = "chrome-roster-live";
      const profile: ChromeMcpProfileOptions = { cdpUrl: `http://127.0.0.1:${fixture.cdpPort}` };
      let targetId: string | undefined;
      try {
        const routeJson = createLiveRouteJson(profileName, fixture);
        const browserAct = async (
          _baseUrl: string | undefined,
          request: unknown,
          opts?: { profile?: string; timeoutMs?: number },
        ) =>
          routeJson(undefined, {
            method: "POST",
            path: "/act",
            query: { profile: opts?.profile },
            body: request,
            timeoutMs: opts?.timeoutMs,
          });
        const getRuntimeConfig = () => ({ browser: createLiveBrowserConfig(profileName, fixture) });
        browserToolTesting.setDepsForTest({
          browserRouteJson: routeJson,
          browserAct,
          getRuntimeConfig,
        });
        browserToolActionTesting.setDepsForTest({ browserAct, getRuntimeConfig });
        const tab = await openChromeMcpTab(
          profileName,
          `http://127.0.0.1:${fixture.httpPort}/roster`,
          profile,
        );
        targetId = tab.targetId;
        await waitForChromeMcpText({
          profileName,
          profile,
          targetId,
          text: ["New Recruit-style Roster Fixture"],
          timeoutMs: 10_000,
        });

        const clickByName = async (nameIncludes: string) => {
          const ref = await snapshotUid({
            profileName,
            profile,
            targetId: targetId!,
            role: "button",
            nameIncludes,
          });
          await expect(
            executeBrowserToolAction({
              action: "act",
              kind: "click",
              profile: profileName,
              targetId,
              ref,
            }),
          ).resolves.toEqual(expect.objectContaining({ ok: true }));
        };
        const typeByName = async (nameIncludes: string, text: string) => {
          const ref = await snapshotUid({
            profileName,
            profile,
            targetId: targetId!,
            role: "textbox",
            nameIncludes,
          });
          await expect(
            executeBrowserToolAction({
              action: "act",
              kind: "type",
              profile: profileName,
              targetId,
              ref,
              text,
            }),
          ).resolves.toEqual(expect.objectContaining({ ok: true }));
        };
        const selectByName = async (nameIncludes: string, value: string) => {
          const ref = await snapshotUid({
            profileName,
            profile,
            targetId: targetId!,
            role: "combobox",
            nameIncludes,
          });
          await expect(
            executeBrowserToolAction({
              action: "act",
              kind: "select",
              profile: profileName,
              targetId,
              ref,
              values: [value],
            }),
          ).resolves.toEqual(expect.objectContaining({ ok: true }));
        };

        await clickByName("Create List");
        await typeByName("List name", "Local Tyranid fixture");
        await selectByName("Faction", "Tyranids");
        await selectByName("Detachment", "Crusher Stampede");
        await typeByName("Unit search", "Termagants");
        await clickByName("Add Termagants");

        await typeByName("Termagants model count", "20");
        await selectByName("Termagants weapon loadout", "Devourers");
        const enhancementRef = await snapshotUid({
          profileName,
          profile,
          targetId,
          role: "checkbox",
          nameIncludes: "Adaptive Biology enhancement",
        });
        await expect(
          executeBrowserToolAction({
            action: "act",
            kind: "click",
            profile: profileName,
            targetId,
            ref: enhancementRef,
          }),
        ).resolves.toEqual(expect.objectContaining({ ok: true }));

        const dragSource = await snapshotUid({
          profileName,
          profile,
          targetId,
          nameIncludes: "Termagants unit card",
        });
        const dropTarget = await snapshotUid({
          profileName,
          profile,
          targetId,
          nameIncludes: "Leader attachment drop zone",
        });
        await expect(
          executeBrowserToolAction({
            action: "act",
            kind: "drag",
            profile: profileName,
            targetId,
            startRef: dragSource,
            endRef: dropTarget,
          }),
        ).resolves.toEqual(expect.objectContaining({ ok: true }));

        await expect(
          executeBrowserToolAction({
            action: "act",
            kind: "wait",
            profile: profileName,
            targetId,
            fn: `() => ["Termagants x20", "Devourers", "Adaptive Biology enhancement", "Roster valid"].every((text) => document.body.innerText.includes(text))`,
            timeoutMs: 10_000,
          }),
        ).resolves.toEqual(expect.objectContaining({ ok: true }));

        await expect(
          executeBrowserToolAction({
            action: "act",
            kind: "evaluate",
            profile: profileName,
            targetId,
            fn: "() => window.__openclawRosterFixture",
          }),
        ).resolves.toEqual(
          expect.objectContaining({
            ok: true,
            result: expect.objectContaining({
              faction: "Tyranids",
              detachment: "Crusher Stampede",
              hasTermagants: true,
              count: 20,
              weapon: "Devourers",
              enhancement: true,
              leaderAttached: true,
              valid: "Roster valid",
            }),
          }),
        );
      } finally {
        browserToolTesting.setDepsForTest(null);
        browserToolActionTesting.setDepsForTest(null);
        if (targetId) {
          await closeChromeMcpTab(profileName, targetId, profile).catch(() => {});
        }
        await stopFixture(fixture);
      }
    },
  );
});
