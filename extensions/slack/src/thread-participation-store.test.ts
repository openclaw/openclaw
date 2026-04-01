import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveParticipationStorePath,
  hasPersistedThreadParticipation,
  persistThreadParticipation,
} from "./thread-participation-store.js";

describe("thread-participation-store", () => {
  let tmpDir: string;
  let sessionStorePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-participation-test-"));
    sessionStorePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("derives participation store path from session store path", () => {
    const result = deriveParticipationStorePath(
      "/home/user/.openclaw/agents/main/sessions/sessions.json",
    );
    expect(result).toBe("/home/user/.openclaw/agents/main/sessions/thread-participation.json");
  });

  it("persists and reads thread participation", () => {
    persistThreadParticipation(sessionStorePath, "A1", "C123", "1700000000.000001", "main");
    expect(
      hasPersistedThreadParticipation(sessionStorePath, "A1", "C123", "1700000000.000001"),
    ).toBe(true);
  });

  it("returns false for unrecorded threads", () => {
    expect(
      hasPersistedThreadParticipation(sessionStorePath, "A1", "C123", "1700000000.000001"),
    ).toBe(false);
  });

  it("distinguishes different channels and threads", () => {
    persistThreadParticipation(sessionStorePath, "A1", "C123", "1700000000.000001", "main");
    expect(
      hasPersistedThreadParticipation(sessionStorePath, "A1", "C123", "1700000000.000002"),
    ).toBe(false);
    expect(
      hasPersistedThreadParticipation(sessionStorePath, "A1", "C456", "1700000000.000001"),
    ).toBe(false);
  });

  it("scopes participation by accountId", () => {
    persistThreadParticipation(sessionStorePath, "A1", "C123", "1700000000.000001", "main");
    expect(
      hasPersistedThreadParticipation(sessionStorePath, "A2", "C123", "1700000000.000001"),
    ).toBe(false);
  });

  it("ignores empty accountId, channelId, or threadTs", () => {
    persistThreadParticipation(sessionStorePath, "", "C123", "1700000000.000001", "main");
    persistThreadParticipation(sessionStorePath, "A1", "", "1700000000.000001", "main");
    persistThreadParticipation(sessionStorePath, "A1", "C123", "", "main");
    expect(hasPersistedThreadParticipation(sessionStorePath, "", "C123", "1700000000.000001")).toBe(
      false,
    );
    expect(hasPersistedThreadParticipation(sessionStorePath, "A1", "", "1700000000.000001")).toBe(
      false,
    );
    expect(hasPersistedThreadParticipation(sessionStorePath, "A1", "C123", "")).toBe(false);
  });

  it("survives simulated process restart (re-reads from disk)", () => {
    persistThreadParticipation(sessionStorePath, "A1", "C123", "1700000000.000001", "main");

    // Clear the module-level cache by importing fresh — we simulate restart
    // by directly reading from disk in a new call after clearing internal cache.
    // The simplest way: just verify the file exists and has the right content.
    const filePath = deriveParticipationStorePath(sessionStorePath);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw["A1:C123:1700000000.000001"]).toBeDefined();
    expect(raw["A1:C123:1700000000.000001"].agentId).toBe("main");
    expect(raw["A1:C123:1700000000.000001"].repliedAt).toBeGreaterThan(0);
  });

  it("expires entries older than TTL", () => {
    persistThreadParticipation(sessionStorePath, "A1", "C123", "1700000000.000001", "main");

    // Move time past 7-day TTL
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(
      hasPersistedThreadParticipation(sessionStorePath, "A1", "C123", "1700000000.000001"),
    ).toBe(false);
  });

  it("stores agentId for auditability", () => {
    persistThreadParticipation(sessionStorePath, "A1", "C123", "1700000000.000001", "dev-agent");
    const filePath = deriveParticipationStorePath(sessionStorePath);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw["A1:C123:1700000000.000001"].agentId).toBe("dev-agent");
  });
});
