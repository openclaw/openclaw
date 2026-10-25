import { readFile, mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "../src/gateway/control-ui-bootstrap-contract.ts";
import {
  installMockGateway,
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";

// A small initial transcript isolates first-paint delays in optional rich renderers.
const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string" },
    "compare-bundle-dir": { type: "string" },
    output: { type: "string", default: ".artifacts/control-ui-rich-boot" },
    pairs: { type: "string", default: "20" },
    "network-latency-ms": { type: "string", default: "0" },
  },
});
if (!values["bundle-dir"] || !values["compare-bundle-dir"]) {
  throw new Error("bundle-dir and compare-bundle-dir are required");
}
const output = path.resolve(values.output, new Date().toISOString().replaceAll(":", "-"));
const base = path.resolve(values["bundle-dir"]);
const head = path.resolve(values["compare-bundle-dir"]);
const pairs = Number(values.pairs);
const networkLatencyMs = Number(values["network-latency-ms"]);
if (
  !Number.isSafeInteger(pairs) ||
  pairs < 1 ||
  !Number.isFinite(networkLatencyMs) ||
  networkLatencyMs < 0
) {
  throw new Error("pairs must be a positive integer and network-latency-ms must be nonnegative");
}
const variants = [
  ["base", base],
  ["control", base],
  ["head", head],
] as const;
const sessionKey = "agent:main:dashboard:rich-risk-proof";
const finalText = "The completed rich run is ready.";
const activeText = "The active run is inspecting the synthetic layout.";
const now = Date.now();
const historyMessages = [
  { role: "user", content: "Inspect the synthetic layout.", timestamp: now - 5000 },
  {
    role: "assistant",
    content: "I will inspect the layout first.",
    phase: "commentary",
    runId: "completed-risk",
    timestamp: now - 4000,
  },
  {
    role: "toolResult",
    toolName: "read",
    toolCallId: "read-layout",
    content: "Synthetic layout inspection complete.",
    runId: "completed-risk",
    timestamp: now - 3000,
  },
  {
    role: "assistant",
    content: finalText,
    phase: "final_answer",
    runId: "completed-risk",
    timestamp: now - 2000,
  },
  { role: "user", content: "Continue with the next synthetic check.", timestamp: now - 1000 },
];
await mkdir(output, { recursive: true });
const server = await startControlUiBenchGatewayServer(base);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: unknown[] = [];
try {
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  for (let pair = 0; pair < pairs; pair++) {
    for (const [variant, bundle] of variants) {
      await server.selectBuild(bundle);
      const source = await readFile(path.join(bundle, "sw.js"), "utf8");
      const buildId = /EMBEDDED_CACHE_VERSION = "([^"]+)"/.exec(source)![1]!;
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        colorScheme: "light",
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        const scenario = {
          serverBuildId: buildId,
          sessionKey,
          historyMessages,
          inFlightRun: { runId: "active-risk", text: activeText, startedAt: now },
          sessionInfo: {
            key: sessionKey,
            hasActiveRun: true,
            activeRunIds: ["active-risk"],
            status: "running",
          },
        };
        await installMockGateway(page, scenario);
        const init = ({
          bootstrap,
          attribute,
          finalText: completedText,
          activeText: runningText,
        }: {
          bootstrap: string;
          attribute: string;
          finalText: string;
          activeText: string;
        }) => {
          const apply = () => {
            if (!document.documentElement) {
              return false;
            }
            document.documentElement.setAttribute(attribute, bootstrap);
            return true;
          };
          if (!apply()) {
            const observer = new MutationObserver(() => {
              if (apply()) {
                observer.disconnect();
              }
            });
            observer.observe(document, { childList: true });
          }
          const timings: Record<string, number> = {};
          Object.assign(window, { __richRiskReadiness: timings });
          const visible = (node: Element) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.top < innerHeight &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };
          const check = () => {
            const composer = document.querySelector<HTMLTextAreaElement>(
              ".agent-chat__composer-combobox textarea",
            );
            if (!timings.composerMs && composer && !composer.disabled && visible(composer)) {
              timings.composerMs = performance.now();
            }
            for (const bubble of document.querySelectorAll("section.chat .chat-text")) {
              if (!visible(bubble)) {
                continue;
              }
              if (!timings.finalMs && bubble.textContent?.includes(completedText)) {
                timings.finalMs = performance.now();
              }
              if (!timings.activeMs && bubble.textContent?.includes(runningText)) {
                timings.activeMs = performance.now();
              }
            }
            if (!timings.composerMs || !timings.finalMs || !timings.activeMs) {
              requestAnimationFrame(check);
            }
          };
          requestAnimationFrame(check);
        };
        const initOptions = {
          bootstrap: JSON.stringify(createControlUiMockBootstrapConfig(scenario)),
          attribute: CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
          finalText,
          activeText,
        };
        await page.addInitScript({
          content: `;(() => { const __name = (fn) => fn; (${init.toString()})(${JSON.stringify(initOptions)}); })();`,
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: networkLatencyMs,
          downloadThroughput: networkLatencyMs ? 1_250_000 : -1,
          uploadThroughput: -1,
        });
        await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
        const before = (await cdp.send("Performance.getMetrics")).metrics;
        const hostLoad = loadavg();
        await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey), {
          waitUntil: "domcontentloaded",
        });
        if (!(await page.evaluate(() => Reflect.has(window, "__richRiskReadiness")))) {
          throw new Error(`Readiness initializer failed: ${errors.join("; ")}`);
        }
        await page.waitForFunction(
          () => {
            const readiness = Reflect.get(window, "__richRiskReadiness");
            return readiness?.composerMs && readiness?.finalMs && readiness?.activeMs;
          },
          undefined,
          { timeout: 30000 },
        );
        const after = (await cdp.send("Performance.getMetrics")).metrics;
        const data = await page.evaluate(() => ({
          readiness: Reflect.get(window, "__richRiskReadiness"),
          resources: performance.getEntriesByType("resource").map((entry) => ({
            name: entry.name,
            startTime: entry.startTime,
            transferSize: Reflect.get(entry, "transferSize"),
          })),
        }));
        const cpu = Object.fromEntries(
          ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map((key) => [
            key,
            1000 *
              (after.find((metric) => metric.name === key)!.value -
                before.find((metric) => metric.name === key)!.value),
          ]),
        );
        results.push({ pair, variant, buildId, hostLoad, ...data, cpu, errors });
        await writeFile(
          path.join(output, "summary.json"),
          JSON.stringify(
            {
              workload: "cold initial completed+active rich run",
              base,
              head,
              pairs,
              networkLatencyMs,
              results,
            },
            null,
            2,
          ),
        );
        if (pair === 0) {
          await page.screenshot({ path: path.join(output, `${variant}.png`) });
        }
        console.log(
          JSON.stringify({ pair, variant, hostLoad, readiness: data.readiness, cpu, errors }),
        );
        if (errors.length) {
          throw new Error(errors.join("\n"));
        }
      } catch (error) {
        await page.screenshot({ path: path.join(output, `${variant}-${pair}-failure.png`) });
        await writeFile(
          path.join(output, `${variant}-${pair}-failure.json`),
          JSON.stringify(
            {
              errors,
              browser: await page.evaluate(() => ({
                readiness: Reflect.get(window, "__richRiskReadiness"),
                text: document.querySelector("section.chat")?.textContent,
              })),
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        await context.close();
      }
    }
  }
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
