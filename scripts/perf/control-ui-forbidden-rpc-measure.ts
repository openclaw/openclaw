// Exercise a real, synthetic Gateway connection and count rejected RPCs on the wire.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    "duration-ms": { type: "string", default: "60000" },
    "output-dir": { type: "string" },
    "browser-path": { type: "string" },
    "proxy-user": { type: "string" },
    label: { type: "string", default: "limited-operator" },
    "ready-text": { type: "string" },
    "show-panels": { type: "boolean", default: false },
  },
});
if (!values.url) {
  throw new Error("--url must name a synthetic loopback Gateway page");
}
const url = new URL(values.url);
const durationMs = Number(values["duration-ms"]);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  Number(url.port) < 40000 ||
  !Number.isFinite(durationMs) ||
  durationMs < 1000
) {
  throw new Error("Use a synthetic loopback Gateway on port >=40000 and a positive duration");
}
const artifact = createControlUiE2eArtifactDir(values.label!, values["output-dir"]);
const browser = await chromium.launch({
  ...(values["browser-path"] ? { executablePath: values["browser-path"] } : {}),
  headless: true,
  args: ["--no-sandbox", "--disable-gpu-rasterization", "--disable-partial-raster"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  serviceWorkers: "block",
  ...(values["proxy-user"]
    ? {
        extraHTTPHeaders: {
          "x-forwarded-for": "192.0.2.10",
          "x-forwarded-proto": "http",
          "x-forwarded-user": values["proxy-user"],
        },
      }
    : {}),
});
const page = await context.newPage();
const connections: { connectedAt?: number; closedAt?: number; scopes?: string[] }[] = [];
const methods: Record<string, { calls: number; succeeded: number; forbidden: number }> = {};
let pageErrors = 0;
page.on("pageerror", () => pageErrors++);
page.on("websocket", (socket) => {
  const connection: (typeof connections)[number] = {};
  const requests = new Map<string, string>();
  connections.push(connection);
  socket.on("close", () => (connection.closedAt = Date.now()));
  socket.on("framesent", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "req") {
      requests.set(frame.id, frame.method);
      const count = (methods[frame.method] ??= { calls: 0, succeeded: 0, forbidden: 0 });
      count.calls++;
    }
  });
  socket.on("framereceived", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type !== "res") {
      return;
    }
    const method = requests.get(frame.id);
    if (!method) {
      return;
    }
    requests.delete(frame.id);
    if (method === "connect" && frame.ok) {
      connection.connectedAt = Date.now();
      connection.scopes = frame.payload?.auth?.scopes;
    }
    if (frame.ok) {
      methods[method]!.succeeded++;
    }
    if (frame.error?.code === "FORBIDDEN") {
      methods[method]!.forbidden++;
    }
  });
});
try {
  await page.goto(url.href);
  await page.waitForFunction(() => document.querySelector("openclaw-app-shell"));
  const deadline = Date.now() + 30000;
  while (!connections.some((connection) => connection.connectedAt)) {
    if (Date.now() >= deadline) {
      await page.screenshot({ path: path.join(artifact, "connection-failed.png") });
      throw new Error("No authenticated hello within 30 seconds");
    }
    await page.waitForTimeout(100);
  }
  if (values["ready-text"]) {
    await page.getByText(values["ready-text"], { exact: false }).first().waitFor();
  }
  if (values["show-panels"]) {
    await page.getByRole("button", { name: "Panels", exact: true }).click();
    await page.locator(".side-panel").waitFor({ state: "visible" });
  }
  await page.waitForTimeout(durationMs);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(artifact, "limited-role.png"),
    animations: "disabled",
  });
} finally {
  await context.close();
  await browser.close();
  const connectionMinutes = connections.reduce(
    (sum, connection) =>
      sum +
      (connection.connectedAt
        ? ((connection.closedAt ?? Date.now()) - connection.connectedAt) / 60000
        : 0),
    0,
  );
  const forbidden = Object.values(methods).reduce((sum, count) => sum + count.forbidden, 0);
  const report = {
    label: values.label,
    durationMs,
    connections,
    connectionMinutes,
    forbidden,
    forbiddenPerConnectionMinute: connectionMinutes ? forbidden / connectionMinutes : null,
    methods,
    pageErrors,
  };
  await writeFile(path.join(artifact, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ artifact, ...report }));
}
