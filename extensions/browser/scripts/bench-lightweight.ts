/** Synthetic, opt-in browser-route compatibility and sampled process-tree benchmark. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

type Engine = "chromium" | "lightpanda";
type Run = { engine: Engine; executable: string } | { engine: Engine; endpoint: string };

const { values } = parseArgs({
  options: {
    lightpanda: { type: "string" },
    chromium: { type: "string" },
    endpoint: { type: "string" },
    engine: { type: "string" },
    "fixture-bind": { type: "string", default: "127.0.0.1" },
    "fixture-host": { type: "string", default: "127.0.0.1" },
    iterations: { type: "string", default: "10" },
    output: { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(
  Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 100,
  "--iterations must be an integer from 1 through 100.",
);
const runs: Run[] = [];
if (values.endpoint) {
  assert(
    !values.lightpanda && !values.chromium,
    "Use either native binaries or an external --endpoint, not both.",
  );
  assert(
    values.engine === "chromium" || values.engine === "lightpanda",
    "--endpoint requires --engine chromium|lightpanda.",
  );
  assert(
    ["http:", "https:", "ws:", "wss:"].includes(new URL(values.endpoint).protocol),
    "--endpoint must be a CDP HTTP or WebSocket URL.",
  );
  runs.push({ engine: values.engine, endpoint: values.endpoint });
} else {
  assert(!values.engine, "--engine requires --endpoint.");
  for (const [engine, executable] of [
    ["chromium", values.chromium],
    ["lightpanda", values.lightpanda],
  ] as const) {
    if (executable) {
      runs.push({ engine, executable: path.resolve(executable) });
    }
  }
}
assert(
  runs.length > 0,
  "Pass --lightpanda <binary>, --chromium <binary>, or --endpoint <url> --engine <engine>.",
);

async function freePort() {
  const server = http.createServer();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
}

async function treeMemory(rootPid: number): Promise<{ rssKiB: number; pssKiB: number } | null> {
  if (process.platform !== "linux") {
    return null;
  }
  const entries = await fs.readdir("/proc").catch(() => null);
  if (!entries) {
    return null;
  }
  let discoveryUnavailable = false;
  const processes = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        try {
          const stat = await fs.readFile(`/proc/${entry}/stat`, "utf8");
          return {
            pid: Number(entry),
            ppid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]),
          };
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              (error.code === "ENOENT" || error.code === "ESRCH")
            )
          ) {
            discoveryUnavailable = true;
          }
          return null;
        }
      }),
  );
  if (discoveryUnavailable) {
    return null;
  }
  const owned = new Set([rootPid]);
  for (;;) {
    const before = owned.size;
    for (const proc of processes) {
      if (proc && owned.has(proc.ppid)) {
        owned.add(proc.pid);
      }
    }
    if (before === owned.size) {
      break;
    }
  }
  let rssKiB = 0;
  let pssKiB = 0;
  for (const pid of owned) {
    try {
      const rollup = await fs.readFile(`/proc/${pid}/smaps_rollup`, "utf8");
      const rss = /^Rss:\s+(\d+)/m.exec(rollup)?.[1];
      const pss = /^Pss:\s+(\d+)/m.exec(rollup)?.[1];
      if (!rss || !pss) {
        return null;
      }
      rssKiB += Number(rss);
      pssKiB += Number(pss);
    } catch (error) {
      const vanished =
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ESRCH");
      if (pid === rootPid || !vanished) {
        return null;
      }
      // Descendants can exit between process discovery and their sample.
    }
  }
  return { rssKiB, pssKiB };
}

async function main() {
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error("Benchmark interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let scratch: string | undefined;
  let submissions = 0;
  const fixture = http.createServer((req, res) => {
    if (req.url === "/submit") {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      submissions++;
      res.end("ok");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><title>Browser fixture</title></head><body>
      <h1>Browser fixture</h1><label>Name <input id="name"></label>
      <button id="save">Save</button><p id="result">Waiting</p>
      <script>document.getElementById('save').onclick = async () => {
        await fetch('/submit', {method: 'POST'});
        document.getElementById('result').textContent = 'Saved: ' + document.getElementById('name').value;
      };</script></body></html>`);
  });
  try {
    // openclaw-temp-dir: allow isolated CLI benchmark owns and removes its scratch tree
    scratch = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-browser-bench-"),
    );
    const scratchDir = scratch;
    process.env.OPENCLAW_STATE_DIR = path.join(scratchDir, "state");
    process.env.OPENCLAW_CONFIG_PATH = path.join(scratchDir, "openclaw.json");
    await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, "{}");
    const {
      resolveBrowserConfig,
      createBrowserRouteContext,
      createBrowserRouteDispatcher,
      closePlaywrightBrowserConnection,
    } = await import("../benchmark-api.js");
    cancellation.signal.throwIfAborted();
    fixture.listen(0, values["fixture-bind"]);
    await once(fixture, "listening");
    const address = fixture.address();
    assert(address && typeof address !== "string");
    const fixtureUrl = new URL(`http://${values["fixture-host"]}:${address.port}/`);
    assert(
      !fixtureUrl.username &&
        !fixtureUrl.password &&
        fixtureUrl.pathname === "/" &&
        !fixtureUrl.search &&
        !fixtureUrl.hash,
      "--fixture-host must be a hostname or bracketed IP address.",
    );

    async function run(spec: Run) {
      const { engine } = spec;
      const port = "executable" in spec ? await freePort() : undefined;
      const cdpUrl =
        "endpoint" in spec
          ? spec.endpoint
          : `${engine === "chromium" ? "http" : "ws"}://127.0.0.1:${port}`;
      let proc: ChildProcess | undefined;
      let processExited = Promise.resolve();
      let spawnFailure: Error | undefined;
      let stderr = "";
      let maxSampledPssKiB = 0;
      let maxSampledRssKiB = 0;
      let sampleCount = 0;
      let memoryUnavailable = false;
      let sampling: Promise<void> | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      let closeOwnedContext: (() => Promise<void>) | undefined;
      const started = performance.now();
      const sample = () => {
        if (sampling) {
          return sampling;
        }
        sampling = (async () => {
          const memory = proc?.pid ? await treeMemory(proc.pid) : null;
          if (memory) {
            sampleCount++;
            maxSampledPssKiB = Math.max(maxSampledPssKiB, memory.pssKiB);
            maxSampledRssKiB = Math.max(maxSampledRssKiB, memory.rssKiB);
          } else {
            memoryUnavailable = true;
          }
        })().finally(() => {
          sampling = undefined;
        });
        return sampling;
      };
      const signalProcess = (signal: NodeJS.Signals) => {
        if (!proc?.pid) {
          return;
        }
        try {
          if (process.platform === "win32") {
            proc.kill(signal);
          } else {
            process.kill(-proc.pid, signal);
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            throw error;
          }
        }
      };
      try {
        let startupMs: number | null = null;
        let engineVersion: string | null = null;
        if ("executable" in spec) {
          const engineHome = path.join(scratchDir, engine);
          await fs.mkdir(engineHome);
          const args =
            engine === "lightpanda"
              ? ["serve", "--host", "127.0.0.1", "--port", String(port)]
              : [
                  // Match OpenClaw's managed headless launch defaults, with a
                  // scratch profile and the container-friendly no-sandbox flag.
                  "--headless=new",
                  "--disable-gpu",
                  "--no-sandbox",
                  ...(process.platform === "linux" ? ["--disable-dev-shm-usage"] : []),
                  "--no-first-run",
                  "--no-default-browser-check",
                  "--disable-sync",
                  "--disable-background-networking",
                  "--disable-component-update",
                  "--disable-features=Translate,MediaRouter",
                  "--disable-session-crashed-bubble",
                  "--hide-crash-restore-bubble",
                  "--password-store=basic",
                  "--no-proxy-server",
                  ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
                  `--user-data-dir=${engineHome}`,
                  `--remote-debugging-port=${port}`,
                ];
          proc = spawn(spec.executable, args, {
            env: {
              PATH: process.env.PATH ?? "",
              HOME: engineHome,
              TMPDIR: scratchDir,
              LIGHTPANDA_DISABLE_TELEMETRY: "true",
              LIGHTPANDA_DISABLE_CORE_DUMP: "1",
              ...(process.env.LD_LIBRARY_PATH
                ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH }
                : {}),
              ...(process.env.FONTCONFIG_FILE
                ? { FONTCONFIG_FILE: process.env.FONTCONFIG_FILE }
                : {}),
              ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            },
            // The benchmark owns this group so failed runs also clean up browser descendants.
            detached: process.platform !== "win32",
            stdio: ["ignore", "ignore", "pipe"],
          });
          proc.stderr?.on("data", (data: Buffer) => {
            stderr = (stderr + data.toString()).slice(-4000);
          });
          processExited = new Promise<void>((resolve) => {
            proc?.once("error", (error) => {
              spawnFailure = error;
              resolve();
            });
            proc?.once("exit", () => resolve());
          });
          timer = setInterval(() => {
            void sample();
          }, 50);
          const startupDeadline = AbortSignal.any([
            cancellation.signal,
            AbortSignal.timeout(15000),
          ]);
          for (;;) {
            startupDeadline.throwIfAborted();
            if (spawnFailure) {
              throw spawnFailure;
            }
            if (proc.exitCode !== null || proc.signalCode !== null) {
              throw new Error(`${engine} exited: ${stderr}`);
            }
            try {
              const fetched = await fetchWithSsrFGuard({
                url: `http://127.0.0.1:${port}/json/version`,
                signal: AbortSignal.any([startupDeadline, AbortSignal.timeout(500)]),
                policy: { allowedHostnames: ["127.0.0.1"], dangerouslyAllowPrivateNetwork: true },
                maxRedirects: 0,
              });
              try {
                const { response } = fetched;
                if (response.ok) {
                  const info: unknown = await response.json();
                  if (info && typeof info === "object") {
                    if (
                      engine === "lightpanda" &&
                      "Lightpanda-Version" in info &&
                      typeof info["Lightpanda-Version"] === "string"
                    ) {
                      engineVersion = info["Lightpanda-Version"];
                    }
                    if (
                      engine === "chromium" &&
                      "Browser" in info &&
                      typeof info.Browser === "string"
                    ) {
                      engineVersion = info.Browser;
                    }
                  }
                  break;
                }
              } finally {
                await fetched.release();
              }
            } catch {
              // Only engine startup readiness retries; workflow actions never replay.
            }
            await delay(50, undefined, { signal: startupDeadline });
          }
          startupMs = performance.now() - started;
        }
        const resolved = resolveBrowserConfig({
          defaultProfile: "bench",
          evaluateEnabled: true,
          snapshotDefaults: { mode: "efficient" },
          ssrfPolicy: {
            allowedHostnames: [fixtureUrl.hostname],
            dangerouslyAllowPrivateNetwork: true,
          },
          profiles: { bench: { engine, cdpUrl, attachOnly: true } },
        });
        const state = { server: null, port: 0, resolved, profiles: new Map() };
        const ctx = createBrowserRouteContext({
          getState: () => state,
          refreshConfigFromDisk: false,
        });
        const dispatcher = createBrowserRouteDispatcher(ctx);
        const dispatch = (
          method: "GET" | "POST" | "DELETE",
          route: string,
          body?: unknown,
          query?: Record<string, unknown>,
        ) =>
          dispatcher.dispatch({
            method,
            path: route,
            body,
            query,
            signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(15000)]),
          });
        const request = async (
          method: "GET" | "POST" | "DELETE",
          route: string,
          body?: unknown,
          query?: Record<string, unknown>,
        ) => {
          const result = await dispatch(method, route, body, query);
          if (result.status !== 200) {
            const diagnostic = await dispatch("GET", "/doctor").catch((error: unknown) => ({
              error: String(error),
            }));
            assert.fail(
              `${engine} ${route}: ${JSON.stringify(result)}; doctor: ${JSON.stringify(diagnostic)}; engine exit: ${proc?.exitCode ?? proc?.signalCode ?? "running/external"}; stderr: ${stderr}`,
            );
          }
          assert(result.body && typeof result.body === "object");
          // SAFETY: The assertion proves a non-null object; each property remains unknown.
          return result.body as Record<string, unknown>;
        };
        let targetId = "";
        closeOwnedContext = async () => {
          try {
            // External Chromium outlives this run; remove only the tab we created.
            if (engine === "chromium" && targetId) {
              await ctx.forProfile().closeTab(targetId, { exactTargetId: true });
            }
          } finally {
            await ctx.forProfile().stopRunningBrowser();
          }
        };
        const task = async (index: number, first: boolean) => {
          const start = performance.now();
          if (first) {
            const opened = await request("POST", "/tabs/open", { url: fixtureUrl.href });
            assert(typeof opened.targetId === "string" && opened.targetId);
            targetId = opened.targetId;
          } else {
            await request("POST", "/navigate", { targetId, url: fixtureUrl.href });
          }
          const snapshot = await request("GET", "/snapshot", undefined, {
            targetId,
            format: "ai",
          });
          const text = String(snapshot.snapshot);
          const nameRef = /textbox[^\n]*\[ref=((?:f\d+)?e\d+)\]/.exec(text)?.[1];
          const saveRef = /button "Save"[^\n]*\[ref=((?:f\d+)?e\d+)\]/.exec(text)?.[1];
          assert(nameRef && saveRef, text);
          await request("POST", "/act", {
            targetId,
            kind: "type",
            ref: nameRef,
            text: `Case ${index}`,
          });
          const before = submissions;
          await request("POST", "/act", { targetId, kind: "click", ref: saveRef });
          await request("POST", "/act", { targetId, kind: "wait", text: `Saved: Case ${index}` });
          const result = await request("GET", "/text", undefined, { targetId });
          assert(JSON.stringify(result).includes(`Saved: Case ${index}`));
          assert.equal(submissions, before + 1, "Submission must occur exactly once");
          return { durationMs: performance.now() - start, snapshotBytes: Buffer.byteLength(text) };
        };
        // The first task includes CDP attachment and initial page open. Warm tasks
        // all include navigation and use the same remaining route sequence.
        const first = await task(0, true);
        const coldStartToFirstCompletionMs = proc ? performance.now() - started : null;
        const tasks = [];
        for (let index = 1; index <= iterations; index++) {
          tasks.push(await task(index, false));
          await sample();
        }
        clearInterval(timer);
        await sample();
        const controllerRssAfterWorkloadMiB = process.memoryUsage().rss / 1024 / 1024;
        const checks: Record<string, boolean> = { workflow: true, exactlyOnceSubmission: true };
        if (engine === "lightpanda") {
          for (const route of [
            "/screenshot",
            "/pdf",
            "/download",
            "/hooks/file-chooser",
            "/hooks/dialog",
            "/screencast",
            "/set/media",
          ]) {
            const result = await dispatch("POST", route, { targetId });
            assert.equal(result.status, 501, `${route}: ${JSON.stringify(result)}`);
          }
          checks.unsupportedCapabilities = true;
          const second = await dispatch("POST", "/tabs/open", { url: fixtureUrl.href });
          assert.notEqual(second.status, 200);
          checks.singlePageLimit = true;
          await closePlaywrightBrowserConnection({ cdpUrl });
          const replacement = await request("POST", "/tabs/open", { url: fixtureUrl.href });
          assert(typeof replacement.targetId === "string" && replacement.targetId);
          assert.notEqual(replacement.targetId, targetId);
          const navigated = await request("POST", "/navigate", {
            targetId: replacement.targetId,
            url: fixtureUrl.href,
          });
          assert.equal(navigated.targetId, replacement.targetId);
          const stale = await dispatch("POST", "/navigate", { targetId, url: fixtureUrl.href });
          assert.equal(stale.status, 404, JSON.stringify(stale));
          assert(stale.body && typeof stale.body === "object" && "error" in stale.body);
          assert(typeof stale.body.error === "string");
          assert.match(stale.body.error, /^tab not found(?::|$)/);
          checks.staleTargetRejected = true;
        }
        const sorted = tasks.map((item) => item.durationMs).toSorted((a, b) => a - b);
        return {
          engine,
          engineVersion,
          connectionMode: proc ? "spawned" : "external",
          warmIterations: iterations,
          checks,
          startupMs,
          firstTaskMs: first.durationMs,
          coldStartToFirstCompletionMs,
          warmP50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
          warmP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
          warmTaskMs: tasks.map((item) => item.durationMs),
          meanWarmSnapshotBytes:
            tasks.reduce((sum, item) => sum + item.snapshotBytes, 0) / iterations,
          engineMaxSampledPssMiB:
            sampleCount && !memoryUnavailable ? maxSampledPssKiB / 1024 : null,
          engineMaxSampledRssMiB:
            sampleCount && !memoryUnavailable ? maxSampledRssKiB / 1024 : null,
          memorySamples: sampleCount,
          controllerRssAfterWorkloadMiB,
        };
      } catch (error) {
        process.stderr.write(`${String(error)}\nEngine stderr: ${stderr}\n`);
        throw error;
      } finally {
        clearInterval(timer);
        await sampling;
        try {
          try {
            await closeOwnedContext?.();
          } finally {
            await closePlaywrightBrowserConnection({ cdpUrl });
          }
        } finally {
          if (proc?.pid && !spawnFailure) {
            if (
              process.platform === "win32" &&
              proc.exitCode === null &&
              proc.signalCode === null
            ) {
              const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
                stdio: "ignore",
              });
              await new Promise<void>((resolve) => {
                killer.once("exit", () => resolve());
                killer.once("error", () => resolve());
              });
            }
            signalProcess("SIGTERM");
            const killTimer = setTimeout(() => signalProcess("SIGKILL"), 3000);
            try {
              await processExited;
            } finally {
              clearTimeout(killTimer);
              signalProcess("SIGKILL");
            }
          }
        }
      }
    }

    const results = [];
    for (const spec of runs) {
      results.push(await run(spec));
    }
    const report = JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        memoryMethod:
          "Maximum sampled Linux /proc descendant-tree PSS/RSS, not a true peak; sampling attempts every 50 ms plus task boundaries. Excludes controller. Null for external engines and unsupported hosts. Controller RSS is a separate end-of-workload sample, not incremental overhead or a peak.",
        workload:
          "Local synthetic form through OpenClaw routes, no LLM. One first task includes initial page open/attachment; each measured warm task includes navigation, default efficient AI snapshot (Lightpanda selects aria refs), typing, exactly one submission, wait and text extraction. Capability/session checks run after measurement.",
        engineOrder: runs.map((spec) => spec.engine),
        results,
      },
      null,
      2,
    );
    if (values.output) {
      await fs.writeFile(values.output, report + "\n");
    }
    process.stdout.write(report + "\n");
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    fixture.closeAllConnections();
    if (fixture.listening) {
      await new Promise<void>((resolve) => {
        fixture.close(() => resolve());
      });
    }
    if (scratch) {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
}

await main();
