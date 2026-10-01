import fs from "node:fs";
import path from "node:path";
import { type FixtureReceiptChannel, withinTest } from "openclaw/plugin-sdk/test-fixtures";
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
    environment: Record<string, string>;
    enabledPlugins: string[];
  };
}

export async function expectSetupPhases(result: Promise<{ code: number | null; output: string }>) {
  const completed = await result;
  expect(completed.code).toBe(0);
  const lines = completed.output.trim().split("\n");
  // Crabbox consumes these stream markers; successful bootstrap emits no other data.
  expect(lines.every((line) => /^CRABBOX_PHASE:[a-z.-]{1,80}$/.test(line))).toBe(true);
  return lines.map((line) => line.slice("CRABBOX_PHASE:".length));
}
