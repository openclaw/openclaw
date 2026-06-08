// Tests for WhatsApp doctor contract (ackReaction migration guard).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor.js";

const hoisted = vi.hoisted(() => {
  let oauthDir = "/tmp/openclaw-doctor-test-oauth";
  return {
    resolveOAuthDir: () => oauthDir,
    setOauthDir: (dir: string) => {
      oauthDir = dir;
    },
  };
});

vi.mock("./auth-store.runtime.js", () => ({
  resolveOAuthDir: hoisted.resolveOAuthDir,
}));

function createTempOAuthDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-test-"));
}

describe("normalizeCompatibilityConfig (ackReaction migration guard)", () => {
  let previousOauthDir: string;

  beforeEach(() => {
    previousOauthDir = hoisted.resolveOAuthDir();
  });

  afterEach(() => {
    hoisted.setOauthDir(previousOauthDir);
  });

  it("does not add whatsapp config when missing and no auth exists", () => {
    // No channels.whatsapp, no auth dir → must not create whatsapp config
    const res = normalizeCompatibilityConfig({
      messages: { ackReaction: "👀" },
    });
    expect(res.config.channels?.whatsapp).toBeUndefined();
    expect(res.changes).toEqual([]);
  });

  it("copies legacy ack reaction when whatsapp config exists", () => {
    const res = normalizeCompatibilityConfig({
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
      channels: { whatsapp: {} },
    });
    expect(res.config.channels?.whatsapp?.ackReaction).toEqual({
      emoji: "👀",
      direct: false,
      group: "mentions",
    });
    expect(res.changes).toEqual([
      "Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: group-mentions).",
    ]);
  });

  it("copies legacy ack reaction when whatsapp auth exists", () => {
    // Set up a fake auth dir with creds.json
    const oauthDir = createTempOAuthDir();
    hoisted.setOauthDir(oauthDir);
    const authDir = path.join(oauthDir, "whatsapp", "default");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "creds.json"), JSON.stringify({ me: {} }));

    const res = normalizeCompatibilityConfig({
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
    });

    expect(res.config.channels?.whatsapp?.ackReaction).toEqual({
      emoji: "👀",
      direct: false,
      group: "mentions",
    });

    // Cleanup
    fs.rmSync(oauthDir, { recursive: true, force: true });
  });

  it("does not overwrite existing whatsapp ackReaction", () => {
    const res = normalizeCompatibilityConfig({
      messages: { ackReaction: "👀" },
      channels: {
        whatsapp: { ackReaction: { emoji: "✅", direct: true, group: "always" } },
      },
    });
    expect(res.config.channels?.whatsapp?.ackReaction).toEqual({
      emoji: "✅",
      direct: true,
      group: "always",
    });
    expect(res.changes).toEqual([]);
  });

  it("skips when no legacy ackReaction is set", () => {
    const res = normalizeCompatibilityConfig({
      messages: {},
    });
    expect(res.changes).toEqual([]);
  });
});
