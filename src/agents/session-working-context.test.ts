import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearWorkingContext,
  normalizeWorkingContext,
  readWorkingContext,
  resolveWorkingContextPath,
  SESSION_WORKING_CONTEXT_VERSION,
  writeWorkingContext,
} from "./session-working-context.js";

const tempDirs: string[] = [];

async function createTempSessionPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-working-context-"));
  tempDirs.push(dir);
  return { dir, file: path.join(dir, "session.jsonl") };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("resolveWorkingContextPath", () => {
  it("places the capsule next to the session file with a .context.json suffix", () => {
    const resolved = resolveWorkingContextPath("/var/data/openclaw/sessions/abc.jsonl");
    expect(resolved).toBe("/var/data/openclaw/sessions/abc.context.json");
  });

  it("handles session files without a .jsonl extension", () => {
    const resolved = resolveWorkingContextPath("/tmp/session");
    expect(resolved).toBe("/tmp/session.context.json");
  });

  it("throws when given an empty path", () => {
    expect(() => resolveWorkingContextPath("")).toThrow(/sessionFile/);
  });
});

describe("normalizeWorkingContext", () => {
  it("drops unknown fields and invalid types", () => {
    const normalized = normalizeWorkingContext({
      cwd: "/work/repo",
      branch: 42, // wrong type
      tempClones: ["/tmp/a", 17, "/tmp/b"],
      sandboxed: "yes", // wrong type
      bogus: "ignored",
    });
    expect(normalized).toEqual({
      cwd: "/work/repo",
      tempClones: ["/tmp/a", "/tmp/b"],
    });
  });

  it("returns an empty object for non-object input", () => {
    expect(normalizeWorkingContext(null)).toEqual({});
    expect(normalizeWorkingContext("oops")).toEqual({});
    expect(normalizeWorkingContext([1, 2])).toEqual({});
  });

  it("preserves boolean false for sandboxed", () => {
    const normalized = normalizeWorkingContext({ sandboxed: false });
    expect(normalized).toEqual({ sandboxed: false });
  });
});

describe("writeWorkingContext / readWorkingContext", () => {
  it("round-trips a typical working-context capsule", async () => {
    const { file } = await createTempSessionPath();
    const capsulePath = await writeWorkingContext(file, {
      cwd: "/work/openclaw",
      activeRepoRoot: "/work/openclaw",
      branch: "feat/context-persistence",
      tempClones: ["/tmp/pr-conflict-clone"],
      lastPushRemote: "origin",
      lastPushBranch: "feat/context-persistence",
      sandboxed: false,
      notes: "resumed after /compact",
    });

    expect(capsulePath.endsWith("session.context.json")).toBe(true);

    const loaded = await readWorkingContext(file);
    expect(loaded).toMatchObject({
      cwd: "/work/openclaw",
      activeRepoRoot: "/work/openclaw",
      branch: "feat/context-persistence",
      tempClones: ["/tmp/pr-conflict-clone"],
      lastPushRemote: "origin",
      lastPushBranch: "feat/context-persistence",
      sandboxed: false,
      notes: "resumed after /compact",
    });
    expect(typeof loaded?.updatedAt).toBe("string");
  });

  it("returns null when no capsule exists", async () => {
    const { file } = await createTempSessionPath();
    expect(await readWorkingContext(file)).toBeNull();
  });

  it("returns null for malformed JSON capsules", async () => {
    const { file } = await createTempSessionPath();
    const capsulePath = resolveWorkingContextPath(file);
    await fs.writeFile(capsulePath, "{not json", "utf-8");
    expect(await readWorkingContext(file)).toBeNull();
  });

  it("returns null when the envelope is missing a version", async () => {
    const { file } = await createTempSessionPath();
    const capsulePath = resolveWorkingContextPath(file);
    await fs.writeFile(capsulePath, JSON.stringify({ context: { cwd: "/x" } }), "utf-8");
    expect(await readWorkingContext(file)).toBeNull();
  });

  it("ignores unknown future fields forward-compatibly", async () => {
    const { file } = await createTempSessionPath();
    const capsulePath = resolveWorkingContextPath(file);
    await fs.writeFile(
      capsulePath,
      JSON.stringify({
        version: SESSION_WORKING_CONTEXT_VERSION + 1,
        context: { cwd: "/x", futureField: { shape: "unknown" } },
      }),
      "utf-8",
    );
    const loaded = await readWorkingContext(file);
    expect(loaded).toMatchObject({ cwd: "/x" });
  });

  it("stamps updatedAt using the provided clock", async () => {
    const { file } = await createTempSessionPath();
    const fixed = new Date("2026-04-24T16:00:00.000Z");
    await writeWorkingContext(file, { cwd: "/x" }, { now: () => fixed });
    const loaded = await readWorkingContext(file);
    expect(loaded?.updatedAt).toBe(fixed.toISOString());
  });

  it("creates the session directory if it does not yet exist", async () => {
    const { dir } = await createTempSessionPath();
    const nestedSessionFile = path.join(dir, "nested", "sessions", "s1.jsonl");
    await writeWorkingContext(nestedSessionFile, { cwd: "/x" });
    const loaded = await readWorkingContext(nestedSessionFile);
    expect(loaded?.cwd).toBe("/x");
  });

  it("overwrites the capsule on subsequent writes", async () => {
    const { file } = await createTempSessionPath();
    await writeWorkingContext(file, { cwd: "/first", branch: "main" });
    await writeWorkingContext(file, { cwd: "/second" });
    const loaded = await readWorkingContext(file);
    expect(loaded?.cwd).toBe("/second");
    expect(loaded?.branch).toBeUndefined();
  });
});

describe("clearWorkingContext", () => {
  it("removes an existing capsule and returns true", async () => {
    const { file } = await createTempSessionPath();
    await writeWorkingContext(file, { cwd: "/x" });
    expect(await clearWorkingContext(file)).toBe(true);
    expect(await readWorkingContext(file)).toBeNull();
  });

  it("returns false when there is nothing to remove", async () => {
    const { file } = await createTempSessionPath();
    expect(await clearWorkingContext(file)).toBe(false);
  });
});
