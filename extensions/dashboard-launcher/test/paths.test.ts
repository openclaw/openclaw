import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DashboardPathError,
  dashboardPath,
  intentFile,
  logPaths,
  pidFile,
  validateMissionControlRoot,
} from "../src/paths.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "dashboard-launcher-paths-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeFakeMissionControl(name = "mc"): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "server.js"), "// stub");
  return dir;
}

describe("dashboardPath", () => {
  test("returns the absolute path when env points at a valid Mission Control directory", () => {
    const dir = makeFakeMissionControl();
    expect(dashboardPath({ OPENCLAW_DASHBOARD_PATH: dir })).toBe(resolve(dir));
  });

  test("normalizes a trailing slash", () => {
    const dir = makeFakeMissionControl();
    expect(dashboardPath({ OPENCLAW_DASHBOARD_PATH: `${dir}/` })).toBe(resolve(dir));
  });

  test("throws DashboardPathError when env is unset", () => {
    expect(() => dashboardPath({})).toThrow(DashboardPathError);
  });

  test("throws DashboardPathError when env is empty string", () => {
    expect(() => dashboardPath({ OPENCLAW_DASHBOARD_PATH: "   " })).toThrow(DashboardPathError);
  });

  test("throws when the path does not exist", () => {
    const missing = join(tmpRoot, "nope");
    expect(() => dashboardPath({ OPENCLAW_DASHBOARD_PATH: missing })).toThrow(/does not exist/);
  });

  test("throws when the path is a file, not a directory", () => {
    const file = join(tmpRoot, "file.txt");
    writeFileSync(file, "not a dir");
    expect(() => dashboardPath({ OPENCLAW_DASHBOARD_PATH: file })).toThrow(/not a directory/);
  });

  test("throws with a Mission Control hint when server.js is missing", () => {
    const dir = join(tmpRoot, "empty");
    mkdirSync(dir, { recursive: true });
    expect(() => dashboardPath({ OPENCLAW_DASHBOARD_PATH: dir })).toThrow(/missing server\.js/);
  });
});

describe("validateMissionControlRoot", () => {
  test("returns when server.js exists", () => {
    const dir = makeFakeMissionControl();
    expect(() => validateMissionControlRoot(dir)).not.toThrow();
  });

  test("throws when server.js is missing", () => {
    const dir = join(tmpRoot, "missing-server");
    mkdirSync(dir, { recursive: true });
    expect(() => validateMissionControlRoot(dir)).toThrow(DashboardPathError);
  });
});

describe("path helpers", () => {
  test("logPaths returns absolute log paths under ~/.openclaw/logs", () => {
    const { outLog, errLog } = logPaths();
    expect(outLog.endsWith("/.openclaw/logs/dashboard.out.log")).toBe(true);
    expect(errLog.endsWith("/.openclaw/logs/dashboard.err.log")).toBe(true);
  });

  test("intentFile and pidFile are under ~/.openclaw", () => {
    expect(intentFile().endsWith("/.openclaw/dashboard.intent")).toBe(true);
    expect(pidFile().endsWith("/.openclaw/dashboard.pid")).toBe(true);
  });
});
