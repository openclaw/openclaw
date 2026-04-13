import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { agentDataRoot, atomicWriteJson, daysBetween, writeBackup } from "../src/utils.js";
import { makeFixture, readJson } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("utils", () => {
  test("agentDataRoot prefers explicit root, then env, then home default", () => {
    vi.stubEnv("LESSON_ENGINE_AGENT_DATA_DIR", "/tmp/lesson-engine-root");
    expect(agentDataRoot("/tmp/explicit-root")).toBe("/tmp/explicit-root");
    expect(agentDataRoot()).toBe("/tmp/lesson-engine-root");
  });

  test("agentDataRoot falls back to AGENT_DATA_ROOT when lesson-engine env is absent", () => {
    vi.stubEnv("LESSON_ENGINE_AGENT_DATA_DIR", "");
    vi.stubEnv("AGENT_DATA_ROOT", "/tmp/agent-data-root");
    expect(agentDataRoot()).toBe("/tmp/agent-data-root");
  });

  test("atomicWriteJson and writeBackup persist JSON files", () => {
    const fx = makeFixture();
    try {
      const filePath = path.join(fx.root, "builder", "memory", "lessons-learned.json");
      atomicWriteJson(filePath, { ok: true });
      expect(readJson<{ ok: boolean }>(filePath).ok).toBe(true);
      const backupPath = writeBackup(filePath, { ok: true }, new Date("2026-04-13T11:50:00Z"));
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(backupPath).toContain(".bak.2026-04-13T11-50-00-000Z");
    } finally {
      fx.cleanup();
    }
  });

  test("daysBetween returns infinity for invalid timestamps", () => {
    expect(daysBetween("invalid", new Date("2026-04-13T00:00:00Z"))).toBe(Number.POSITIVE_INFINITY);
  });
});
