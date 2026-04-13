import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Lesson, LessonsFile } from "../src/types.js";

export interface TmpFixture {
  root: string;
  agentFile: (agent: string) => string;
  cleanup: () => void;
}

/** Spin up a scratch AGENT_DATA_ROOT. Caller must call cleanup(). */
export function makeFixture(): TmpFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-engine-test-"));
  // Isolate session-scanning from the developer's real ~/.openclaw/agents/
  // by pointing OPENCLAW_SESSIONS_ROOT at an empty subdir in the fixture.
  // Tests that need real sessions can write their own JSONL under <root>/sessions/<agent>/sessions/.
  const sessionsRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const priorEnv = process.env.OPENCLAW_SESSIONS_ROOT;
  process.env.OPENCLAW_SESSIONS_ROOT = sessionsRoot;
  return {
    root,
    agentFile: (agent: string) => path.join(root, agent, "memory", "lessons-learned.json"),
    cleanup: () => {
      if (priorEnv === undefined) delete process.env.OPENCLAW_SESSIONS_ROOT;
      else process.env.OPENCLAW_SESSIONS_ROOT = priorEnv;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Write a lessons-learned.json file for the given agent. */
export function writeLessons(fixture: TmpFixture, agent: string, data: unknown): string {
  const filePath = fixture.agentFile(agent);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

/** Build a minimal post-migration lesson with overrides. */
export function makeLesson(partial: Partial<Lesson> & { id: string }): Lesson {
  const defaults: Lesson = {
    id: partial.id,
    title: partial.title ?? `title-${partial.id}`,
    category: partial.category ?? "general",
    tags: partial.tags ?? [],
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00+08:00",
    severity: partial.severity ?? "important",
    hitCount: partial.hitCount ?? 0,
    appliedCount: partial.appliedCount ?? 0,
    lastHitAt: partial.lastHitAt ?? null,
    mergedFrom: partial.mergedFrom ?? [],
    duplicateOf: partial.duplicateOf ?? null,
    lifecycle: partial.lifecycle ?? "active",
  };
  return { ...defaults, ...partial };
}

export function makeFile(lessons: Lesson[], extras: Partial<LessonsFile> = {}): LessonsFile {
  return {
    version: 1,
    lessons,
    ...extras,
  } as LessonsFile;
}
