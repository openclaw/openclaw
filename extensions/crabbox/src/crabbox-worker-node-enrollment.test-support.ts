import fs from "node:fs";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  fixtureReceiptClientSource,
  type FixtureReceiptChannel,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import * as tar from "tar";
import { expect } from "vitest";
import type {
  CrabboxWorkerNodeEnrollment,
  CrabboxWorkerNodeRuntimePreparation,
} from "./crabbox-worker-node-enrollment.js";

export type DesktopFixture = {
  enabled: boolean;
  setup?: string;
  display?: string;
  dbus?: string;
  runtimeDir?: string;
};

export function createWorkerArchiveFixture(): CrabboxWorkerNodeRuntimePreparation["workerBundle"] {
  return {
    url: "https://gateway.example.test/__openclaw__/worker-bootstrap/artifacts/worker",
    token: "synthetic-worker-archive-token",
    sha256: "b".repeat(64),
    bytes: 100,
    packageRelativePath: `worker-artifacts/${"b".repeat(64)}.tgz`,
  };
}

export function createNodeBootstrapFixture(
  overrides: Partial<CrabboxWorkerNodeEnrollment["nodeBootstrap"]> = {},
): CrabboxWorkerNodeEnrollment["nodeBootstrap"] {
  return {
    url: "https://gateway.example.test/__openclaw__/node-bootstrap/v1/artifact",
    token: "synthetic-bootstrap-token",
    sha256: "a".repeat(64),
    bytes: 100,
    openclawVersion: "2026.8.1",
    enabledPluginIds: ["demo"],
    ...overrides,
  };
}

export async function readLaunch(
  stateDir: string,
  receipts: FixtureReceiptChannel,
  signal: AbortSignal,
) {
  // Enrollment writes node.pid before completing; the child publishes JSON before its receipt.
  const pid = fs.readFileSync(path.join(stateDir, "node.pid"), "utf8").trim();
  await withinTest(receipts.waitFor(stateDir, `launched:${pid}:ready`), signal);
  return JSON.parse(fs.readFileSync(path.join(stateDir, "launch.json"), "utf8")) as {
    build: string;
    cli: string;
    args: string[];
    token?: string;
    setupCode?: string;
    tool?: string;
    environment: Record<string, string>;
    enabledPlugins: string[];
  };
}

export async function createNodePackageFixture(
  makeTempDir: (prefix: string) => string,
  build: string,
  receipts: FixtureReceiptChannel,
  postinstall = "",
): Promise<Buffer> {
  const root = makeTempDir("crabbox-bootstrap-package-");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.8.1",
      scripts: { postinstall: "node install.cjs" },
    }),
  );
  fs.writeFileSync(
    path.join(packageRoot, "install.cjs"),
    `require("node:fs").writeFileSync("installed.json", JSON.stringify({ token: process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN, setupCode: process.env.CRABBOX_WORKER_SETUP_CODE, scriptsRan: true }));${postinstall}`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "openclaw.mjs"),
    `import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
${fixtureReceiptClientSource(receipts.endpoint)}
const args = process.argv.slice(2);
const state = process.env.OPENCLAW_STATE_DIR;
if (args[0] === "--version") {
  console.log("OpenClaw 2026.8.1");
} else if (args[0] === "plugins" && args[1] === "enable") {
  fs.appendFileSync(path.join(state, "activation.jsonl"), JSON.stringify({ runtimePublished: fs.existsSync(path.join(state, "runtime")) }) + "\\n");
  if (${JSON.stringify(build)} === "activation-failed") { console.error("plugin dependency missing"); process.exit(1); }
  for (const id of args.slice(2)) {
    if (${JSON.stringify(build)} === "verbose-activation") process.stdout.write("x".repeat(700_000));
    fs.appendFileSync(path.join(state, "enabled"), id + "\\n");
  }
} else {
  process.title = "openclaw-connect";
  const enabledFile = path.join(state, "enabled");
  const enabledPlugins = fs.existsSync(enabledFile) ? fs.readFileSync(enabledFile, "utf8").trim().split("\\n") : [];
  fs.writeFileSync(path.join(state, "launch.json.tmp"), JSON.stringify({ build: ${JSON.stringify(build)}, args, cli: process.argv[1], token: process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN, setupCode: process.env.CRABBOX_WORKER_SETUP_CODE, tool: process.platform !== "win32" ? execFileSync("bootstrap-tool-fixture", {encoding:"utf8"}).trim() : undefined, environment: { DISPLAY: process.env.DISPLAY, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }, enabledPlugins }));
  // Existence signals readiness only after the child publishes complete JSON.
  fs.renameSync(path.join(state, "launch.json.tmp"), path.join(state, "launch.json"));
  sendReceipt(state, "launched:" + process.pid + ":ready");
  const desktopReady = path.join(process.env.HOME, "desktop-ready");
  if (fs.existsSync(desktopReady)) fs.writeFileSync(desktopReady, "ready\\n");
  setInterval(() => {}, 60000);
}
`,
  );
  const tools = path.join(packageRoot, "dist", "worker-tools", "bin");
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, "bootstrap-tool-fixture"), "#!/bin/sh\necho verified-tool\n", {
    mode: 0o755,
  });
  const archive = path.join(root, "package.tgz");
  await tar.create({ cwd: root, file: archive, gzip: true }, ["package"]);
  return fs.readFileSync(archive);
}

export async function expectSetupPhases(
  result: Promise<{ code: number | null; output: string; leaseId: string; setupCode: string }>,
) {
  const completed = await result;
  expect(completed.code).toBe(0);
  const lines = completed.output.trim().split("\n");
  expect(
    lines.every((line) => /^(CRABBOX_PHASE:[a-z.-]{1,80}|CRABBOX_WORKER_STAGE:\{.*\})$/.test(line)),
  ).toBe(true);
  const milestones: unknown[] = lines
    .filter((line) => line.startsWith("CRABBOX_WORKER_STAGE:"))
    .map((line) => JSON.parse(line.slice("CRABBOX_WORKER_STAGE:".length)));
  expect(milestones).toContainEqual(
    expect.objectContaining({
      leaseId: completed.leaseId,
      stage: "preparation",
      elapsedMs: 0,
      outcome: "started",
    }),
  );
  expect(milestones).toContainEqual(
    expect.objectContaining({
      leaseId: completed.leaseId,
      stage: "complete",
      elapsedMs: 0,
      outcome: "completed",
    }),
  );
  expect(
    milestones.every(
      (event) =>
        isRecord(event) &&
        event.leaseId === completed.leaseId &&
        typeof event.elapsedMs === "number" &&
        Number.isSafeInteger(event.elapsedMs) &&
        event.elapsedMs >= 0 &&
        typeof event.totalElapsedMs === "number" &&
        Number.isSafeInteger(event.totalElapsedMs) &&
        event.totalElapsedMs >= event.elapsedMs,
    ),
  ).toBe(true);
  expect(completed.output).not.toContain(completed.setupCode);
  return lines
    .filter((line) => line.startsWith("CRABBOX_PHASE:"))
    .map((line) => line.slice("CRABBOX_PHASE:".length));
}
