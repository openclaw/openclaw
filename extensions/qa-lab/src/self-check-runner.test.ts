// The self-check runs a real gateway loop in-process; it must never read or write the
// operator's default state directory.
import { existsSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

const startQaLabServer = vi.hoisted(() => vi.fn());
// mock-isolation: the real lab server starts a gateway loop this test must not run.
vi.mock("./lab-server.js", () => ({ startQaLabServer }));

import { runQaE2eSelfCheck } from "./self-check-runner.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
afterEach(() => {
  startQaLabServer.mockReset();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

it("runs against an isolated state dir and restores the operator's", async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  let stateDirDuringRun: string | undefined;
  startQaLabServer.mockImplementation(async () => ({
    runSelfCheck: async () => {
      stateDirDuringRun = process.env.OPENCLAW_STATE_DIR;
      return { outputPath: "/tmp/report.json" };
    },
    stop: async () => {},
  }));

  await runQaE2eSelfCheck();

  expect(stateDirDuringRun).toContain("openclaw-qa-self-check-");
  expect(existsSync(stateDirDuringRun!)).toBe(false);
  expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
});

it("restores an operator state dir that was already configured", async () => {
  process.env.OPENCLAW_STATE_DIR = "/operator/state";
  startQaLabServer.mockImplementation(async () => ({
    runSelfCheck: async () => {
      expect(process.env.OPENCLAW_STATE_DIR).not.toBe("/operator/state");
      return { outputPath: "/tmp/report.json" };
    },
    stop: async () => {},
  }));

  await runQaE2eSelfCheck();

  expect(process.env.OPENCLAW_STATE_DIR).toBe("/operator/state");
});
