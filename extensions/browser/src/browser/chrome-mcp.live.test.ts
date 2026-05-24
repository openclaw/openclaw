import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  focusChromeMcpTab,
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
import { DEFAULT_UPLOAD_DIR } from "./paths.js";
import { createBrowserRouteDispatcher } from "./routes/dispatcher.js";
import type { BrowserDispatchRequest } from "./routes/dispatcher.js";
import { createBrowserRouteContext } from "./server-context.js";
import type { BrowserServerState } from "./server-context.js";

const CHROME_BIN = process.env.OPENCLAW_LIVE_BROWSER_CHROME_BIN?.trim() || "/usr/bin/google-chrome";
const LIVE = isLiveTestEnabled(["OPENCLAW_BROWSER_CHROME_MCP_LIVE_TEST"]) && existsSync(CHROME_BIN);
const describeLive = LIVE ? describe : describe.skip;

type LiveFixture = {
  cdpPort: number;
  chrome: ChildProcess;
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
    button, input, select, textarea { font: inherit; margin: 4px; padding: 6px; }
    .builder { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .panel, .unit-card, .summary, .gauntlet { background: white; border: 1px solid #bbb; border-radius: 6px; padding: 12px; }
    .unit-card { margin-top: 12px; }
    canvas { border: 1px solid #555; background: #fafafa; }
    iframe { width: 100%; height: 120px; border: 1px solid #777; }
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
          <label>Roster notes <textarea id="roster-notes" aria-label="Roster notes"></textarea></label>
          <button id="rules-help" aria-label="Show rules help">Show rules help</button>
          <button id="validate-dialog" aria-label="Validate roster dialog">Validate roster dialog</button>
          <label>Import roster file <input id="roster-upload" aria-label="Roster import file" type="file"></label>
          <p id="upload-status">No roster file imported.</p>
        </div>
        <div id="leader-drop" class="unit-card" role="button" tabindex="0" aria-label="Leader attachment drop zone">Attach leader here</div>
        <div class="unit-card">
          <h2>Deployment Map</h2>
          <canvas id="deployment-map" aria-label="Deployment objective map" width="320" height="160"></canvas>
          <p id="canvas-status">No objective selected.</p>
        </div>
        <div class="unit-card">
          <h2>Nested Rules Frame</h2>
          <iframe id="rules-frame" title="Roster rules frame" srcdoc="<button id='frame-rule'>Mark Synapse Rule</button><p id='frame-result'>No frame rule selected.</p><script>document.getElementById('frame-rule').addEventListener('click',()=>{document.getElementById('frame-result').textContent='Synapse rule selected'; parent.postMessage({type:'frame-rule', value:'Synapse rule selected'}, '*');});</script>"></iframe>
          <p id="frame-status">No frame event.</p>
        </div>
      </div>
    </section>
    <aside class="summary" aria-live="polite">
      <h2>Roster Summary</h2>
      <p id="summary-line">No roster yet.</p>
      <p id="points-line">0 pts</p>
      <p id="valid-line" class="valid">Waiting for units</p>
    </aside>
    <script>
      const state = { created: false, faction: 'Adeptus Astartes', detachment: 'Invasion Fleet', hasTermagants: false, count: 10, weapon: 'Fleshborers', enhancement: false, leaderAttached: false, notes: '', uploadedFile: '', objective: '', dialogResult: '', frameRule: '' };
      const $ = (id) => document.getElementById(id);
      const render = () => {
        $('builder').classList.toggle('hidden', !state.created);
        $('empty-state').classList.toggle('hidden', state.hasTermagants);
        $('termagants-card').classList.toggle('hidden', !state.hasTermagants);
        const unitLine = state.hasTermagants ? 'Termagants x' + state.count + ' with ' + state.weapon : 'No units selected';
        const enhancement = state.enhancement ? ' + Adaptive Biology enhancement' : '';
        const leader = state.leaderAttached ? ' + leader attached' : '';
        const file = state.uploadedFile ? ' + import ' + state.uploadedFile : '';
        const objective = state.objective ? ' + objective ' + state.objective : '';
        const frameRule = state.frameRule ? ' + ' + state.frameRule : '';
        const points = state.hasTermagants ? 60 + Math.max(0, state.count - 10) * 6 + (state.weapon === 'Devourers' ? 10 : 0) + (state.enhancement ? 25 : 0) + (state.leaderAttached ? 80 : 0) : 0;
        $('summary-line').textContent = state.faction + ' / ' + state.detachment + ': ' + unitLine + enhancement + leader + file + objective + frameRule;
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
      $('termagants-card').addEventListener('dragstart', (event) => { state.draggingTermagants = true; event.dataTransfer.setData('text/plain', 'Termagants'); });
      $('termagants-card').addEventListener('mousedown', () => { state.draggingTermagants = true; });
      $('leader-drop').addEventListener('dragover', (event) => event.preventDefault());
      $('leader-drop').addEventListener('drop', (event) => { event.preventDefault(); state.leaderAttached = true; state.draggingTermagants = false; render(); });
      $('leader-drop').addEventListener('mouseup', () => { if (state.draggingTermagants) { state.leaderAttached = true; state.draggingTermagants = false; render(); } });
      $('roster-notes').addEventListener('input', (event) => { state.notes = event.target.value; render(); });
      $('rules-help').addEventListener('mouseenter', () => { state.hoveredHelp = true; render(); });
      $('validate-dialog').addEventListener('click', () => { state.dialogResult = prompt('Roster validation note?', 'ready') || ''; render(); });
      $('roster-upload').addEventListener('input', (event) => { state.uploadedFile = event.target.files?.[0]?.name || ''; $('upload-status').textContent = state.uploadedFile ? 'Imported ' + state.uploadedFile : 'No roster file imported.'; render(); });
      $('deployment-map').addEventListener('click', (event) => { const rect = event.currentTarget.getBoundingClientRect(); state.objective = Math.round(event.clientX - rect.left) + ',' + Math.round(event.clientY - rect.top); $('canvas-status').textContent = 'Objective selected at ' + state.objective; render(); });
      window.addEventListener('message', (event) => { if (event.data?.type === 'frame-rule') { state.frameRule = event.data.value; $('frame-status').textContent = event.data.value; render(); } });
      const ctx = $('deployment-map').getContext('2d'); ctx.fillStyle = '#dceeff'; ctx.fillRect(20, 20, 80, 50); ctx.fillStyle = '#333'; ctx.fillText('Objective A', 34, 50);
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
    if (/Tool .+ not found/.test(message) || message.includes("Method not available")) {
      return undefined;
    }
    throw err;
  }
}

function createLiveBrowserConfig(
  profileName: string,
  fixture: LiveFixture,
  opts: { extensionPipeProfileName?: string } = {},
): ResolvedBrowserConfig {
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
    noSandbox: true,
    attachOnly: true,
    defaultProfile: profileName,
    profiles: {
      [profileName]: {
        driver: "existing-session",
        cdpUrl: `http://127.0.0.1:${fixture.cdpPort}`,
        color: "#00AA00",
      },
      ...(opts.extensionPipeProfileName
        ? {
            [opts.extensionPipeProfileName]: {
              driver: "existing-session" as const,
              executablePath: CHROME_BIN,
              headless: true,
              mcpArgs: ["--isolated", "--no-usage-statistics"],
              color: "#AA00AA",
            },
          }
        : {}),
    },
    tabCleanup: { enabled: false, idleMinutes: 0, maxTabsPerSession: 0, sweepMinutes: 0 },
    ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
    extraArgs: [],
  };
}

function createLiveRouteJson(
  profileName: string,
  fixture: LiveFixture,
  opts: { extensionPipeProfileName?: string } = {},
) {
  const state: BrowserServerState = {
    port: 0,
    resolved: createLiveBrowserConfig(profileName, fixture, opts),
    profiles: new Map(),
  };
  const ctx = createBrowserRouteContext({ getState: () => state });
  const dispatcher = createBrowserRouteDispatcher(ctx);
  return async <T = unknown>(
    _baseUrl: string | undefined,
    req: {
      method: BrowserDispatchRequest["method"];
      path: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      timeoutMs?: number;
    },
  ): Promise<T> => {
    const response = await dispatcher.dispatch({
      method: req.method,
      path: req.path,
      query: req.query,
      body: req.body,
    });
    if (response.status >= 400) {
      throw new Error(JSON.stringify(response.body));
    }
    return response.body as T;
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
      const nameMatches = (current.name ?? "").includes(params.nameIncludes);
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
          (message.text ?? "").includes("openclaw-live-fixture"),
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
          (request.url ?? "").includes("/api/data.json"),
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
          (message.text ?? "").includes("openclaw-live-fixture"),
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
          (request.url ?? "").includes("/api/data.json"),
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
    "proves the Browser tool surface through live Chrome MCP sandbox actions",
    { timeout: 300_000 },
    async () => {
      const fixture = await startFixture();
      const profileName = "chrome-tool-surface-live";
      const extensionPipeProfileName = "chrome-tool-surface-live-extensions-pipe";
      const profile: ChromeMcpProfileOptions = { cdpUrl: `http://127.0.0.1:${fixture.cdpPort}` };
      const coverage: Record<string, { status: "pass" | "unsupported"; note?: string }> = {};
      let targetId: string | undefined;
      const mark = (name: string, note?: string) => {
        coverage[name] = { status: "pass", ...(note ? { note } : {}) };
      };
      const markUnsupported = (name: string, error: unknown) => {
        coverage[name] = {
          status: "unsupported",
          note: error instanceof Error ? error.message : String(error),
        };
      };
      const action = (args: Record<string, unknown>) =>
        executeBrowserToolAction({ profile: profileName, targetId, ...args });
      const tryAction = async (name: string, args: Record<string, unknown>) => {
        try {
          const result = await action(args);
          mark(name, JSON.stringify(result).slice(0, 240));
          return result;
        } catch (error) {
          markUnsupported(name, error);
          return undefined;
        }
      };
      try {
        const routeJson = createLiveRouteJson(profileName, fixture, { extensionPipeProfileName });
        const routeImageResult = async (params: { path: string; label: string }) => ({
          content: [{ type: "text" as const, text: `IMAGE:${params.path}` }],
          details: { ok: true, path: params.path, label: params.label },
        });
        browserToolTesting.setDepsForTest({
          browserRouteJson: routeJson,
          browserDoctor: async (_baseUrl, opts: any) =>
            routeJson(undefined, {
              method: "GET",
              path: "/doctor",
              query: { profile: opts.profile },
              timeoutMs: opts.timeoutMs,
            }),
          browserStatus: async (_baseUrl, opts: any) =>
            routeJson(undefined, {
              method: "GET",
              path: "/",
              query: { profile: opts.profile },
              timeoutMs: opts.timeoutMs,
            }),
          browserStart: async (_baseUrl, opts: any) => {
            await routeJson(undefined, {
              method: "POST",
              path: "/start",
              query: { profile: opts.profile },
              timeoutMs: opts.timeoutMs,
            });
          },
          browserStop: async (_baseUrl, opts: any) => {
            await routeJson(undefined, {
              method: "POST",
              path: "/stop",
              query: { profile: opts.profile },
              timeoutMs: opts.timeoutMs,
            });
          },
          browserProfiles: async (_baseUrl, opts: any) =>
            (
              await routeJson<{ profiles: any[] }>(undefined, {
                method: "GET",
                path: "/profiles",
                timeoutMs: opts.timeoutMs,
              })
            ).profiles,
          browserOpenTab: async (_baseUrl, url, opts: any) =>
            routeJson(undefined, {
              method: "POST",
              path: "/tabs/open",
              query: { profile: opts.profile },
              body: { url, label: opts.label },
              timeoutMs: opts.timeoutMs,
            }),
          browserFocusTab: async (_baseUrl, focusTargetId, opts: any) => {
            await routeJson(undefined, {
              method: "POST",
              path: "/tabs/focus",
              query: { profile: opts.profile },
              body: { targetId: focusTargetId },
              timeoutMs: opts.timeoutMs,
            });
          },
          browserCloseTab: async (_baseUrl, closeTargetId, opts: any) => {
            await routeJson(undefined, {
              method: "DELETE",
              path: `/tabs/${encodeURIComponent(closeTargetId)}`,
              query: { profile: opts.profile },
              timeoutMs: opts.timeoutMs,
            });
          },
          browserNavigate: async (_baseUrl, opts: any) =>
            routeJson(undefined, {
              method: "POST",
              path: "/navigate",
              query: { profile: opts.profile },
              body: { url: opts.url, targetId: opts.targetId },
            }),
          browserScreenshotAction: async (_baseUrl, opts: any) =>
            routeJson(undefined, {
              method: "POST",
              path: "/screenshot",
              query: { profile: opts.profile },
              body: opts,
              timeoutMs: opts.timeoutMs,
            }),
          browserPdfSave: async (_baseUrl, opts: any) =>
            routeJson(undefined, {
              method: "POST",
              path: "/pdf",
              query: { profile: opts.profile },
              body: { targetId: opts.targetId },
            }),
          getRuntimeConfig: () => ({
            browser: createLiveBrowserConfig(profileName, fixture, { extensionPipeProfileName }),
          }),
          imageResultFromFile: routeImageResult,
        });
        browserToolActionTesting.setDepsForTest({
          browserAct: async (_baseUrl, request, opts: any) =>
            routeJson(undefined, {
              method: "POST",
              path: "/act",
              query: { profile: opts?.profile },
              body: request,
              timeoutMs: opts?.timeoutMs,
            }),
          browserTabs: async (_baseUrl, opts: any) =>
            (
              await routeJson<{ tabs: any[] }>(undefined, {
                method: "GET",
                path: "/tabs",
                query: { profile: opts.profile },
                timeoutMs: opts.timeoutMs,
              })
            ).tabs,
          browserSnapshot: async (_baseUrl, opts: any) =>
            routeJson(undefined, {
              method: "GET",
              path: "/snapshot",
              query: opts,
            }),
          browserConsoleMessages: async (_baseUrl, opts: any) =>
            routeJson(undefined, {
              method: "GET",
              path: "/console",
              query: opts,
            }),
          browserNetworkRequests: async (_baseUrl, opts: any) =>
            routeJson(undefined, {
              method: "GET",
              path: "/requests",
              query: opts,
            }),
          imageResultFromFile: routeImageResult,
          getRuntimeConfig: () => ({
            browser: createLiveBrowserConfig(profileName, fixture, { extensionPipeProfileName }),
          }),
        });

        await expect(action({ action: "status" })).resolves.toEqual(
          expect.objectContaining({ enabled: true }),
        );
        mark("status");
        await expect(action({ action: "doctor" })).resolves.toEqual(expect.objectContaining({}));
        mark("doctor");
        await expect(action({ action: "profiles" })).resolves.toEqual(
          expect.objectContaining({ profiles: expect.any(Array) }),
        );
        mark("profiles");
        await expect(action({ action: "start" })).resolves.toEqual(expect.objectContaining({}));
        mark("start");

        const opened = await action({
          action: "open",
          targetUrl: `http://127.0.0.1:${fixture.httpPort}/`,
          label: "tool-surface-fixture",
        });
        targetId = String(opened.targetId);
        expect(targetId).toBeTruthy();
        mark("open");
        await waitForChromeMcpText({
          profileName,
          profile,
          targetId,
          text: ["OpenClaw Chrome MCP live fixture"],
          timeoutMs: 10_000,
        });

        await expect(action({ action: "tabs" })).resolves.toEqual(
          expect.objectContaining({ tabs: expect.any(Array) }),
        );
        mark("tabs");
        await expect(action({ action: "focus" })).resolves.toEqual(
          expect.objectContaining({ ok: true }),
        );
        mark("focus");
        await expect(action({ action: "snapshot", snapshotFormat: "aria" })).resolves.toEqual(
          expect.objectContaining({ ok: true, targetId }),
        );
        mark("snapshot:aria");
        await expect(
          action({ action: "snapshot", snapshotFormat: "ai", maxChars: 2_000 }),
        ).resolves.toEqual(expect.objectContaining({ ok: true, targetId }));
        mark("snapshot:ai");
        await expect(
          action({ action: "screenshot", type: "png", fullPage: false }),
        ).resolves.toEqual(expect.objectContaining({ ok: true }));
        mark("screenshot");
        await tryAction("pdf", { action: "pdf" });

        await expect(
          action({ action: "navigate", targetUrl: `http://127.0.0.1:${fixture.httpPort}/roster` }),
        ).resolves.toEqual(expect.objectContaining({ ok: true, targetId }));
        mark("navigate");
        await waitForChromeMcpText({
          profileName,
          profile,
          targetId,
          text: ["New Recruit-style Roster Fixture"],
          timeoutMs: 10_000,
        });
        await expect(
          action({ action: "navigate", targetUrl: `http://127.0.0.1:${fixture.httpPort}/` }),
        ).resolves.toEqual(expect.objectContaining({ ok: true, targetId }));
        await waitForChromeMcpText({
          profileName,
          profile,
          targetId,
          text: ["OpenClaw Chrome MCP live fixture"],
          timeoutMs: 10_000,
        });

        await resetChromeMcpSessionsForTest();
        const consoleTab = await openChromeMcpTab(
          profileName,
          `data:text/html,${encodeURIComponent(
            "<!doctype html><title>Console fixture</title><script>console.log('openclaw-live-fixture-tool-surface-console');</script><body>Console fixture</body>",
          )}`,
          profile,
        );
        try {
          await waitForChromeMcpText({
            profileName,
            profile,
            targetId: consoleTab.targetId,
            text: ["Console fixture"],
            timeoutMs: 10_000,
          });
          const directConsoleMessages = await listChromeMcpConsoleMessages({
            profileName,
            profile,
            targetId: consoleTab.targetId,
            includePreservedMessages: true,
            pageSize: 20,
          });
          const consoleHit = directConsoleMessages.messages.find((message) =>
            (message.text ?? "").includes("openclaw-live-fixture-tool-surface-console"),
          );
          expect(consoleHit?.id).toEqual(expect.any(Number));
          const consoleList = await action({
            action: "console",
            targetId: consoleTab.targetId,
            level: "log",
          });
          expect(consoleList).toEqual(
            expect.objectContaining({ ok: true, messageCount: expect.any(Number) }),
          );
          mark("console");
          await focusChromeMcpTab(profileName, consoleTab.targetId, profile);
          await expect(
            action({
              action: "console-message",
              targetId: consoleTab.targetId,
              msgid: consoleHit?.id,
            }),
          ).resolves.toEqual(expect.objectContaining({ ok: true }));
          mark("console-message");
        } finally {
          await closeChromeMcpTab(profileName, consoleTab.targetId, profile).catch(() => {});
        }

        await expect(
          action({ action: "navigate", targetUrl: `http://127.0.0.1:${fixture.httpPort}/` }),
        ).resolves.toEqual(expect.objectContaining({ ok: true, targetId }));
        await waitForChromeMcpText({
          profileName,
          profile,
          targetId,
          text: ["OpenClaw Chrome MCP live fixture"],
          timeoutMs: 10_000,
        });
        await evaluateChromeMcpScript({
          profileName,
          profile,
          targetId,
          fn: "() => fetch('/api/data.json?tool-surface=' + Date.now()).then((response) => response.json()).then((data) => data.ok)",
        });
        const directNetworkRequests = await listChromeMcpNetworkRequests({
          profileName,
          profile,
          targetId,
          includePreservedRequests: true,
          pageSize: 50,
        });
        const requests = await action({ action: "requests", filter: "/api/data.json" });
        expect(requests).toEqual(
          expect.objectContaining({ ok: true, requestCount: expect.any(Number) }),
        );
        mark("requests");
        const requestHit = directNetworkRequests.requests.find((request) =>
          (request.url ?? "").includes("/api/data.json"),
        );
        const reqid =
          typeof requestHit?.requestId === "number" ? requestHit.requestId : Number(requestHit?.id);
        expect(reqid).toEqual(expect.any(Number));
        await expect(action({ action: "request-detail", reqid })).resolves.toEqual(
          expect.objectContaining({ ok: true }),
        );
        mark("request-detail");

        for (const emulate of [
          { name: "emulate:offline", args: { operation: "offline", offline: false } },
          {
            name: "emulate:headers",
            args: { operation: "headers", headers: { "x-openclaw-live": "yes" } },
          },
          {
            name: "emulate:geolocation",
            args: {
              operation: "geolocation",
              latitude: 49.2827,
              longitude: -123.1207,
              accuracy: 10,
            },
          },
          { name: "emulate:media", args: { operation: "media", colorScheme: "dark" } },
        ]) {
          await tryAction(emulate.name, { action: "emulate", ...emulate.args });
        }

        await expect(action({ action: "trace", operation: "start" })).resolves.toEqual(
          expect.objectContaining({ ok: true }),
        );
        mark("trace:start");
        await evaluateChromeMcpScript({
          profileName,
          profile,
          targetId,
          fn: "() => { for (let i = 0; i < 1000; i++) Math.sqrt(i); return true; }",
        });
        await expect(action({ action: "trace", operation: "stop" })).resolves.toEqual(
          expect.objectContaining({ ok: true }),
        );
        mark("trace:stop");
        await tryAction("trace:insight", {
          action: "trace",
          operation: "insight",
          insightSetId: "navigation-1",
          insightName: "DocumentLatency",
        });

        await tryAction("heap-snapshot:take", {
          action: "heap-snapshot",
          operation: "take",
          timeoutMs: 20_000,
        });
        await expect(
          action({
            action: "lighthouse",
            mode: "snapshot",
            device: "desktop",
            outputDirPath: path.join(fixture.root, "out"),
            timeoutMs: 60_000,
          }),
        ).resolves.toEqual(expect.objectContaining({ ok: true }));
        mark("lighthouse");
        await expect(
          action({ action: "screencast", operation: "start", timeoutMs: 15_000 }),
        ).resolves.toEqual(expect.objectContaining({ ok: true }));
        mark("screencast:start");
        await expect(
          action({ action: "screencast", operation: "stop", timeoutMs: 15_000 }),
        ).resolves.toEqual(expect.objectContaining({ ok: true }));
        mark("screencast:stop");

        await expect(
          executeBrowserToolAction({
            profile: extensionPipeProfileName,
            action: "extensions",
            operation: "list",
            timeoutMs: 20_000,
          }),
        ).resolves.toEqual(expect.objectContaining({ ok: true, extensions: expect.any(Array) }));
        mark("extensions:list");
        await expect(action({ action: "extensions", operation: "tab-id" })).resolves.toEqual(
          expect.objectContaining({ ok: true, tabId: expect.any(String) }),
        );
        mark("extensions:tab-id");
        await tryAction("third-party-tools:list", {
          action: "third-party-tools",
          operation: "list",
        });
        await tryAction("web-mcp-tools:list", { action: "web-mcp-tools", operation: "list" });

        await expect(
          action({ action: "act", kind: "evaluate", fn: "() => document.title" }),
        ).resolves.toEqual(expect.objectContaining({ ok: true }));
        mark("act:evaluate");
        await expect(action({ action: "act", kind: "close" })).resolves.toEqual(
          expect.objectContaining({ ok: true }),
        );
        mark("act:close");
        targetId = undefined;
        await expect(action({ action: "stop" })).resolves.toEqual(expect.objectContaining({}));
        mark("stop");

        console.log("openclaw-browser-tool-surface-coverage", JSON.stringify(coverage));
        expect(coverage).toMatchObject({
          status: { status: "pass" },
          doctor: { status: "pass" },
          profiles: { status: "pass" },
          start: { status: "pass" },
          open: { status: "pass" },
          tabs: { status: "pass" },
          focus: { status: "pass" },
          "snapshot:aria": { status: "pass" },
          "snapshot:ai": { status: "pass" },
          screenshot: { status: "pass" },
          navigate: { status: "pass" },
          console: { status: "pass" },
          "console-message": { status: "pass" },
          requests: { status: "pass" },
          "request-detail": { status: "pass" },
          "emulate:media": { status: "pass" },
          lighthouse: { status: "pass" },
          "screencast:start": { status: "pass" },
          "screencast:stop": { status: "pass" },
          "extensions:list": { status: "pass" },
          "extensions:tab-id": { status: "pass" },
          "act:evaluate": { status: "pass" },
          "act:close": { status: "pass" },
          stop: { status: "pass" },
        });
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
        const browserAct: any = async (
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

  it(
    "proves a complex roster gauntlet across Chrome MCP Browser tool abilities",
    { timeout: 240_000 },
    async () => {
      const fixture = await startFixture();
      const profileName = "chrome-roster-gauntlet-live";
      const profile: ChromeMcpProfileOptions = { cdpUrl: `http://127.0.0.1:${fixture.cdpPort}` };
      let targetId: string | undefined;
      const uploadPath = path.join(DEFAULT_UPLOAD_DIR, `roster-gauntlet-${Date.now()}.rosz`);
      try {
        await mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
        await writeFile(uploadPath, "openclaw roster gauntlet import");
        const routeJson = createLiveRouteJson(profileName, fixture);
        const browserAct: any = async (
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
          browserArmFileChooser: async (_baseUrl, opts: any) =>
            routeJson(undefined, {
              method: "POST",
              path: "/hooks/file-chooser",
              query: { profile: opts.profile },
              body: opts,
              timeoutMs: opts.timeoutMs,
            }),
          browserArmDialog: async (_baseUrl, opts: any) =>
            routeJson(undefined, {
              method: "POST",
              path: "/hooks/dialog",
              query: { profile: opts.profile },
              body: opts,
              timeoutMs: opts.timeoutMs,
            }),
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

        const refBy = (params: { role?: string; nameIncludes: string }) =>
          snapshotUid({ profileName, profile, targetId: targetId!, ...params });
        const act = (args: Record<string, unknown>) =>
          executeBrowserToolAction({ action: "act", profile: profileName, targetId, ...args });

        await act({ kind: "resize", width: 1280, height: 900 });
        await act({
          kind: "click",
          ref: await refBy({ role: "button", nameIncludes: "Create List" }),
        });
        await act({
          kind: "fill",
          fields: [
            {
              ref: await refBy({ role: "textbox", nameIncludes: "List name" }),
              value: "Gauntlet Tyranids",
            },
            {
              ref: await refBy({ role: "textbox", nameIncludes: "Unit search" }),
              value: "Termagants",
            },
          ],
        });
        await act({
          kind: "select",
          ref: await refBy({ role: "combobox", nameIncludes: "Faction" }),
          values: ["Tyranids"],
        });
        await act({
          kind: "select",
          ref: await refBy({ role: "combobox", nameIncludes: "Detachment" }),
          values: ["Crusher Stampede"],
        });
        await act({
          kind: "click",
          ref: await refBy({ role: "button", nameIncludes: "Add Termagants" }),
        });
        await act({
          kind: "type",
          ref: await refBy({ role: "textbox", nameIncludes: "Termagants model count" }),
          text: "25",
        });
        await act({
          kind: "press",
          ref: await refBy({ role: "textbox", nameIncludes: "Termagants model count" }),
          key: "ArrowUp",
        });
        await act({
          kind: "select",
          ref: await refBy({ role: "combobox", nameIncludes: "Termagants weapon loadout" }),
          values: ["Spinefists"],
        });
        await act({
          kind: "click",
          ref: await refBy({ role: "checkbox", nameIncludes: "Adaptive Biology enhancement" }),
        });
        await act({
          kind: "hover",
          ref: await refBy({ role: "button", nameIncludes: "Show rules help" }),
        });
        await act({
          kind: "type",
          ref: await refBy({ role: "textbox", nameIncludes: "Roster notes" }),
          text: "Synapse web, screen, and battleline checks complete.",
        });

        const fileRef = await refBy({ nameIncludes: "Roster import file" });
        await expect(
          executeBrowserToolAction({
            action: "upload",
            profile: profileName,
            targetId,
            inputRef: fileRef,
            paths: [uploadPath],
          }),
        ).resolves.toEqual(expect.objectContaining({ ok: true }));

        const canvasClick = (await act({
          kind: "evaluate",
          fn: `() => { const r = document.getElementById('deployment-map').getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + 45) }; }`,
        })) as { result?: { x?: number; y?: number } };
        await act({ kind: "clickCoords", x: canvasClick.result?.x, y: canvasClick.result?.y });

        await expect(
          executeBrowserToolAction({
            action: "dialog",
            profile: profileName,
            targetId,
            accept: true,
            promptText: "validation accepted",
          }),
        ).resolves.toEqual(expect.objectContaining({ ok: true }));
        await act({
          kind: "click",
          ref: await refBy({ role: "button", nameIncludes: "Validate roster dialog" }),
        });

        await act({
          kind: "evaluate",
          fn: `() => { const frame = document.getElementById('rules-frame'); frame.contentDocument.getElementById('frame-rule').click(); return true; }`,
        });
        await act({
          kind: "wait",
          fn: `() => ["Imported", "Objective selected", "Synapse rule selected", "Roster valid"].every((text) => document.body.innerText.includes(text))`,
          timeoutMs: 10_000,
        });

        await expect(
          act({ kind: "evaluate", fn: "() => window.__openclawRosterFixture" }),
        ).resolves.toEqual(
          expect.objectContaining({
            ok: true,
            result: expect.objectContaining({
              faction: "Tyranids",
              detachment: "Crusher Stampede",
              hasTermagants: true,
              weapon: "Spinefists",
              enhancement: true,
              uploadedFile: expect.stringContaining("roster-gauntlet"),
              objective: expect.stringContaining(","),
              dialogResult: "validation accepted",
              frameRule: "Synapse rule selected",
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
        await rm(uploadPath, { force: true }).catch(() => {});
        await stopFixture(fixture);
      }
    },
  );
});
