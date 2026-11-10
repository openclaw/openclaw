// Real isolated Gateway + public registry + production UI. No mocked RPCs or simulated delays.
// Acceptance: mean first-catalog-RPC-to-content latency <= 50% of 10-run baseline
// in >=5 candidate runs for BOTH surfaces, with equal identities and full contents.
// Cold browser context per sample; resident Gateway, uncontrolled shared upstream caches.
// Keep the approved content-readiness boundary fixed across baseline and candidate.
// Trusted-click and automation-call timings are separate diagnostics, not boot proof.
// node --import ./scripts/tsx.mjs scripts/bench-templates-catalog.mts
//   --config <isolated config> --output <JSON> --samples 10 --label baseline
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Locator } from "playwright";
import type {
  RequestFrame,
  ResponseFrame,
} from "../packages/gateway-protocol/src/schema/frames.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type {
  ClawHubTemplateCatalogDetail,
  ClawHubTemplateCatalogOverview,
} from "../src/templates/clawhub-source.js";
import { resolvePlaywrightChromiumExecutablePath } from "../ui/src/test-helpers/playwright-chromium.ts";
async function markActivation(target: Locator) {
  await target.evaluate((element) => {
    element.addEventListener(
      "click",
      (event) => {
        if (event.isTrusted) {
          performance.clearMarks("templates-bench-click");
          performance.mark("templates-bench-click");
        }
      },
      { once: true, capture: true },
    );
  });
}

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    "compare-config": { type: "string" },
    output: { type: "string" },
    samples: { type: "string", default: "10" },
    label: { type: "string", default: "baseline" },
    upstream: {
      type: "string",
      default: "real public ClawHub; shared upstream cache state not controlled",
    },
    package: { type: "string", default: "@openclaw/executive-briefing" },
  },
});
assert(values.config && values.output, "Pass isolated --config and --output");
const configs = await Promise.all(
  [values.config, values["compare-config"]]
    .filter((file): file is string => Boolean(file))
    .map(async (file) => {
      const config = JSON.parse(await fs.readFile(file, "utf8")) as OpenClawConfig;
      assert(config.gateway?.bind === "loopback");
      const port = config.gateway.port;
      const token = config.gateway.auth?.token;
      assert(
        typeof port === "number" && typeof token === "string" && token.trim(),
        "Use isolated token-auth configs",
      );
      return { port, token };
    }),
);
const count = Number(values.samples);
assert(Number.isSafeInteger(count) && count >= 1);
await fs.mkdir(path.dirname(values.output), { recursive: true });
const browser = await chromium.launch({
  executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  args: ["--no-sandbox"],
});
type Run = { arm: string; surface: string } & (
  | { ok: true; ms: number; activationMs: number; content: unknown }
  | { ok: false; error: string }
);
const runs: Run[] = [];
const report = {
  label: values.label,
  primaryMetric: "ms",
  metric: "first templates.catalog request to rendered complete contents",
  activationMetric: "trusted native click event to DOM-content assertion (browser clock)",
  automationMetric: "Playwright click call to readiness, including actionability wait",
  browserState: "fresh context per sample",
  gatewayState: "resident isolated real Gateway",
  upstream: values.upstream,
  runs,
};
try {
  for (let sample = 1; sample <= count; sample++) {
    for (const surface of ["listing", "detail"]) {
      for (const index of sample % 2 ? [...configs.keys()] : [...configs.keys()].toReversed()) {
        const config = configs[index]!;
        const origin = "http://127.0.0.1:" + config.port;
        const arm = index === 0 ? values.label! : "candidate";
        const redact = (value: string) =>
          value
            .replaceAll(config.token, "[REDACTED]")
            .replaceAll(encodeURIComponent(config.token), "[REDACTED]");
        const context = await browser.newContext({
          locale: "en-US",
          viewport: { width: 1440, height: 1000 },
          serviceWorkers: "block",
        });
        const page = await context.newPage();
        const requests: Array<{
          id: string;
          method: string;
          params: unknown;
          start: number;
          end?: number;
          ok?: boolean;
          payload?: unknown;
          error?: string;
        }> = [];
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(redact(error.message)));
        page.on("websocket", (socket) => {
          socket.on("framesent", (event) => {
            try {
              const f = JSON.parse(String(event.payload)) as RequestFrame | ResponseFrame;
              if (f.type === "req") {
                requests.push({
                  id: f.id,
                  method: f.method,
                  params: f.method.startsWith("templates.catalog.") ? f.params : undefined,
                  start: performance.now(),
                });
              }
            } catch {}
          });
          socket.on("framereceived", (event) => {
            try {
              const f = JSON.parse(String(event.payload)) as RequestFrame | ResponseFrame;
              if (f.type === "res") {
                const r = requests.find((request) => request.id === f.id);
                if (r) {
                  r.end = performance.now();
                  r.ok = f.ok;
                  r.payload = f.payload;
                  r.error = f.error?.message ? redact(f.error.message) : undefined;
                }
              }
            } catch {}
          });
        });
        const startedAt = new Date().toISOString();
        const navigation = performance.now();
        let content: unknown;
        let activation = 0;
        try {
          // Settle authenticated settings first. On this base, first-connection bootstrap
          // omits Labs flags; its visible Refresh loads authoritative configuration.
          await page.goto(origin + "/settings/labs#token=" + encodeURIComponent(config.token), {
            waitUntil: "domcontentloaded",
          });
          await page.waitForTimeout(1500);
          const refresh = page.getByRole("button", { name: "Refresh configuration", exact: true });
          if (await refresh.isVisible()) {
            await refresh.click();
          }
          await page.waitForFunction(() =>
            document.querySelector(
              '.settings-row input[role="switch"],.settings-row button[role="switch"]',
            ),
          );
          await page.getByRole("button", { name: "Back to app", exact: true }).click();
          await page.getByRole("button", { name: "Pages", exact: true }).click();
          const templates = page.locator('[data-sidebar-entry="route:templates"] a').first();
          await templates.waitFor();
          requests.length = 0;
          activation = performance.now();
          await markActivation(templates);
          await templates.click();
          if (surface === "detail") {
            await page.locator("[data-templates-entry]").first().waitFor({ timeout: 120000 });
            const overview = requests.find((r) => r.method === "templates.catalog.search" && r.ok)
              ?.payload as { overview: ClawHubTemplateCatalogOverview };
            const entry = [
              ...overview.overview.featured,
              ...overview.overview.sections.flatMap((s) => s.entries),
            ].find((e) => e.packageName === values.package);
            assert(entry, "Workload package must be present in the real catalog");
            requests.length = 0;
            activation = performance.now();
            const add = page
              .locator("[data-templates-entry]")
              .filter({ has: page.getByRole("heading", { name: entry.displayName, exact: true }) })
              .first()
              .locator(".agents-home__template-add");
            await markActivation(add);
            await add.click();
          }
          await page.waitForFunction(
            () =>
              document.querySelector(
                '[data-templates-entry],.plugin-catalog-detail__summary,[role="alert"]',
              ),
            {},
            { timeout: 120000 },
          );
          const method =
            surface === "listing" ? "templates.catalog.search" : "templates.catalog.detail";
          const deadline = Date.now() + 120000;
          while (!requests.some((r) => r.method === method && r.end && r.ok)) {
            const failed = requests.find((r) => r.method === method && r.end && !r.ok);
            assert(!failed, failed?.error ?? method + " failed");
            assert(Date.now() < deadline, "Missing successful " + method);
            await new Promise((resolve) => {
              setTimeout(resolve, 20);
            });
          }
          const response = requests.findLast((r) => r.method === method && r.ok)!.payload as {
            overview: ClawHubTemplateCatalogOverview;
            detail: ClawHubTemplateCatalogDetail;
          };
          if (surface === "listing") {
            const overview = response.overview;
            assert(overview && overview.sections.length > 0, "Complete overview required");
            const expected =
              overview.featured.length +
              overview.sections.reduce((n, s) => n + s.entries.length, 0);
            await page.waitForFunction(
              (n) => document.querySelectorAll("[data-templates-entry]").length === n,
              expected,
              { timeout: 30000 },
            );
            content = overview;
          } else {
            const detail = response.detail;
            assert(detail.packageName === values.package);
            await page
              .locator(
                ".plugin-catalog-detail:not(.plugin-catalog-detail--loading) [data-templates-confirm]",
              )
              .waitFor({ timeout: 30000 });
            // Read rendered text: hidden content must not satisfy the readiness boundary.
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content
            const text = await page.locator(".plugin-catalog-detail").innerText();
            for (const item of [
              ...detail.contents.instructions.filter((instruction) =>
                [
                  "AGENTS.md",
                  "SOUL.md",
                  "USER.md",
                  "IDENTITY.md",
                  "BOOTSTRAP.md",
                  "MEMORY.md",
                  "TOOLS.md",
                  "HEARTBEAT.md",
                ].includes(instruction.name),
              ),
              ...detail.contents.skills,
              ...detail.contents.integrations,
              ...detail.contents.automations,
            ]) {
              assert(text.includes(item.name), "Missing visible content " + item.name);
            }
            if (detail.contents.instructions.some((item) => item.name.includes("/"))) {
              assert(text.includes("View all"), "Complete workspace inventory must be reachable");
            }
            content = {
              packageName: detail.packageName,
              version: detail.version,
              contents: detail.contents,
            };
          }
          const end = performance.now();
          const activationMs = await page.evaluate(() => {
            const mark = performance.getEntriesByName("templates-bench-click").at(-1);
            if (!mark) {
              throw new Error("Missing trusted native click event");
            }
            return performance.now() - mark.startTime;
          });
          const catalog = requests.filter((r) => r.method.startsWith("templates.catalog."));
          assert(catalog.length > 0);
          assert(errors.length === 0, "Browser errors: " + errors.join("; "));
          const row = {
            arm,
            sample,
            surface,
            ok: true as const,
            startedAt,
            completedAt: new Date().toISOString(),
            ms: end - catalog[0]!.start,
            activationMs,
            automationMs: end - activation,
            workflowMs: end - navigation,
            loadavg: loadavg(),
            requests: requests.map(({ payload: _payload, ...r }) => ({
              ...r,
              ms: r.end ? r.end - r.start : undefined,
            })),
            content,
            errors,
          };
          runs.push(row);
          console.log(JSON.stringify({ ...row, content: undefined }));
        } catch (error) {
          const row = {
            arm,
            sample,
            surface,
            ok: false as const,
            startedAt,
            completedAt: new Date().toISOString(),
            error: redact(String(error)),
            url: new URL(page.url()).pathname,
            text: redact((await page.locator("body").textContent()) ?? "").slice(0, 8000),
            requests: requests.map(({ payload: _payload, ...r }) => r),
            errors,
          };
          runs.push(row);
          console.log(JSON.stringify(row));
          await fs.writeFile(values.output, JSON.stringify(report, null, 2));
          // Playwright causes retain credential-bearing navigation URLs and call logs.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(row.error);
        } finally {
          await context.close();
          await fs.writeFile(values.output, JSON.stringify(report, null, 2));
        }
      }
    }
  }
} finally {
  await browser.close();
}
const completed = runs.filter((row) => row.ok);
function summarizeTimes(samples: number[]) {
  const times = samples.toSorted((a, b) => a - b);
  return {
    averageMs: times.reduce((a, b) => a + b, 0) / times.length,
    medianMs:
      (times[Math.floor((times.length - 1) / 2)]! + times[Math.ceil((times.length - 1) / 2)]!) / 2,
    p95Ms: times[Math.ceil(times.length * 0.95) - 1],
    minMs: times[0],
    maxMs: times.at(-1),
  };
}
const summary = [...new Set(completed.map((row) => row.arm))].flatMap((arm) =>
  ["listing", "detail"].map((surface) => {
    const rows = completed.filter((row) => row.arm === arm && row.surface === surface);
    return Object.assign(
      { arm, surface, samples: rows.length },
      summarizeTimes(rows.map((row) => row.ms)),
      { activation: summarizeTimes(rows.map((row) => row.activationMs)) },
    );
  }),
);
const parity = ["listing", "detail"].map((surface) => {
  const rows = completed.filter((row) => row.surface === surface);
  return {
    surface,
    equal: rows.every((row) => JSON.stringify(row.content) === JSON.stringify(rows[0]?.content)),
  };
});
await fs.writeFile(values.output, JSON.stringify({ ...report, summary, parity }, null, 2));
console.log(JSON.stringify({ summary, parity }));
assert(
  parity.every((row) => row.equal),
  "Content parity changed; inspect raw responses",
);
