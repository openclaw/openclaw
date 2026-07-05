import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  diagnose,
  inspectInstalledCodex,
  inspectMemory,
  inspectNativeHookRelayRecords,
  pidIsAlive,
} from "./aerith-runtime-resilience.mjs";

test("pidIsAlive rejects impossible pids", () => {
  assert.equal(pidIsAlive(-1), false);
  assert.equal(pidIsAlive(0), false);
});

test("inspectMemory classifies large bootstrap memory as critical", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aerith-memory-"));
  fs.writeFileSync(path.join(dir, "MEMORY.md"), "x".repeat(260_000));

  const result = inspectMemory(dir);

  assert.equal(result.exists, true);
  assert.equal(result.bootstrapRisk, "critical");
});

test("inspectNativeHookRelayRecords marks dead records stale", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aerith-relay-"));
  fs.writeFileSync(
    path.join(dir, "relay.json"),
    `${JSON.stringify({
      version: 1,
      relayId: "relay-1",
      pid: 999_999_999,
      hostname: "127.0.0.1",
      port: 9,
      token: "token",
      expiresAtMs: Date.now() + 60_000,
    })}\n`,
  );

  const result = await inspectNativeHookRelayRecords({ bridgeDir: dir });

  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.stale, 1);
  assert.equal(result.records[0]?.stale, true);
});

test("inspectInstalledCodex detects missing runtime directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aerith-openclaw-home-"));

  const result = inspectInstalledCodex(dir);

  assert.equal(result.exists, false);
  assert.equal(result.persistsNativeHookRelayGeneration, false);
});

test("diagnose reports oversized memory and missing installed runtime", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aerith-workspace-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aerith-home-"));
  fs.mkdirSync(path.join(home, "agents/main/sessions"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "MEMORY.md"), "x".repeat(120_000));

  const result = await diagnose({
    workspaceDir: workspace,
    openclawHome: home,
    bridgeDir: fs.mkdtempSync(path.join(os.tmpdir(), "aerith-relay-empty-")),
  });

  assert.equal(result.ok, false);
  assert.match(result.findings.join(","), /memory_bootstrap_payload_too_large/);
});
