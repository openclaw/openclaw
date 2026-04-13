import * as fs from "node:fs";
import { describe, expect, test } from "vitest";
import { writeCandidatesFile } from "../src/distill.js";
import { DEFAULT_CONFIDENCE_THRESHOLD, gateCandidates } from "../src/gate.js";
import type { CandidatesFile, LessonCandidate, LessonsFile } from "../src/types.js";
import { makeFile, makeFixture, makeLesson, readJson, writeLessons } from "./helpers.js";

function makeCandidate(overrides: Partial<LessonCandidate> = {}): LessonCandidate {
  return {
    id: "cand-20260413-abc12345",
    distillKey: "dk1234567890abcd",
    agent: "builder",
    title: "Avoid reading protected files",
    category: "filesystem",
    tags: ["permissions"],
    context: "When accessing system files",
    mistake: "Reading without permission",
    lesson: "Check permissions first",
    fix: "Use stat before read",
    severity: "high",
    confidence: 0.85,
    evidenceRefs: [
      {
        sessionKey: "sess-001",
        agent: "builder",
        tool: "Read",
        errorFingerprint: "fp001",
        timestamp: "2026-04-13T10:00:00Z",
      },
    ],
    status: "pending",
    createdAt: "2026-04-13T10:00:00Z",
    ...overrides,
  };
}

describe("gate", () => {
  test("promotes candidate above confidence threshold", () => {
    const fx = makeFixture();
    try {
      writeLessons(fx, "builder", makeFile([]));
      const candidate = makeCandidate({ confidence: 0.9 });
      const candidatesFile: CandidatesFile = {
        version: 1,
        promptVersion: "p1.distill.v1",
        updatedAt: "2026-04-13T10:00:00Z",
        candidates: [candidate],
      };
      writeCandidatesFile(candidatesFile, fx.root);

      const result = gateCandidates({ root: fx.root, agents: ["builder"], dryRun: true });
      expect(result.promoted).toBe(1);
      expect(result.rejected).toBe(0);
      expect(result.decisions[0].action).toBe("promoted");
    } finally {
      fx.cleanup();
    }
  });

  test("rejects candidate below confidence threshold", () => {
    const fx = makeFixture();
    try {
      writeLessons(fx, "builder", makeFile([]));
      const candidate = makeCandidate({ confidence: 0.3 });
      const candidatesFile: CandidatesFile = {
        version: 1,
        promptVersion: "p1.distill.v1",
        updatedAt: "",
        candidates: [candidate],
      };
      writeCandidatesFile(candidatesFile, fx.root);

      const result = gateCandidates({
        root: fx.root,
        agents: ["builder"],
        confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
      });
      expect(result.rejected).toBe(1);
      expect(result.decisions[0].reason).toBe("low-confidence");
    } finally {
      fx.cleanup();
    }
  });

  test("rejects candidate duplicate of existing active lesson", () => {
    const fx = makeFixture();
    try {
      writeLessons(
        fx,
        "builder",
        makeFile([
          makeLesson({
            id: "existing-1",
            title: "Avoid reading protected files",
            category: "filesystem",
            tags: ["permissions"],
          }),
        ]),
      );
      const candidate = makeCandidate({
        confidence: 0.9,
        title: "Avoid reading protected files",
        category: "filesystem",
        tags: ["permissions"],
      });
      writeCandidatesFile(
        {
          version: 1,
          promptVersion: "p1.distill.v1",
          updatedAt: "",
          candidates: [candidate],
        },
        fx.root,
      );

      const result = gateCandidates({ root: fx.root, agents: ["builder"] });
      expect(result.rejected).toBe(1);
      expect(result.decisions[0].reason).toBe("duplicate");
      expect(result.decisions[0].matchingLessonId).toBe("existing-1");
    } finally {
      fx.cleanup();
    }
  });

  test("promotion writes lesson to lessons file in apply mode", () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", makeFile([]));
      const candidate = makeCandidate({
        confidence: 0.9,
        title: "Unique new lesson about docker networking",
        category: "devops",
        tags: ["docker"],
      });
      writeCandidatesFile(
        {
          version: 1,
          promptVersion: "p1.distill.v1",
          updatedAt: "",
          candidates: [candidate],
        },
        fx.root,
      );

      const result = gateCandidates({
        root: fx.root,
        agents: ["builder"],
        dryRun: false,
      });
      expect(result.promoted).toBe(1);

      // Check lessons file was updated
      const lessonsFile = readJson<LessonsFile>(filePath);
      expect(lessonsFile.lessons).toHaveLength(1);
      expect(lessonsFile.lessons[0].title).toBe("Unique new lesson about docker networking");
      expect(lessonsFile.lessons[0].lifecycle).toBe("active");

      // Check candidates file was updated
      const candidatesPath = filePath.replace(
        "builder/memory/lessons-learned.json",
        "shared/lessons/candidates.json",
      );
      const updatedCandidates = readJson<CandidatesFile>(candidatesPath);
      expect(updatedCandidates.candidates[0].status).toBe("promoted");
      expect(updatedCandidates.candidates[0].promotedAt).toBeTruthy();
    } finally {
      fx.cleanup();
    }
  });

  test("skips non-pending candidates", () => {
    const fx = makeFixture();
    try {
      writeLessons(fx, "builder", makeFile([]));
      const candidate = makeCandidate({ status: "promoted", confidence: 0.9 });
      writeCandidatesFile(
        {
          version: 1,
          promptVersion: "p1.distill.v1",
          updatedAt: "",
          candidates: [candidate],
        },
        fx.root,
      );

      const result = gateCandidates({ root: fx.root, agents: ["builder"] });
      expect(result.promoted).toBe(0);
      expect(result.rejected).toBe(0);
      expect(result.decisions).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("dry-run does not write to disk", () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", makeFile([]));
      const candidate = makeCandidate({ confidence: 0.9, title: "brand new unique lesson xyz" });
      writeCandidatesFile(
        {
          version: 1,
          promptVersion: "p1.distill.v1",
          updatedAt: "",
          candidates: [candidate],
        },
        fx.root,
      );

      const before = fs.readFileSync(filePath, "utf8");
      gateCandidates({ root: fx.root, agents: ["builder"], dryRun: true });
      const after = fs.readFileSync(filePath, "utf8");
      expect(after).toBe(before);
    } finally {
      fx.cleanup();
    }
  });

  test("promoted lesson includes date field in YYYY-MM-DD format", () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", makeFile([]));
      const candidate = makeCandidate({
        confidence: 0.9,
        title: "Unique lesson for date field test",
        category: "operations",
        tags: ["date-test"],
      });
      writeCandidatesFile(
        {
          version: 1,
          promptVersion: "p1.distill.v1",
          updatedAt: "",
          candidates: [candidate],
        },
        fx.root,
      );

      const now = new Date("2026-04-13T12:00:00Z");
      const result = gateCandidates({
        root: fx.root,
        agents: ["builder"],
        dryRun: false,
        now,
      });
      expect(result.promoted).toBe(1);

      const lessonsFile = readJson<LessonsFile>(filePath);
      expect(lessonsFile.lessons).toHaveLength(1);
      const lesson = lessonsFile.lessons[0];
      expect(lesson.date).toBeDefined();
      expect(lesson.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(lesson.date).toBe("2026-04-13");
    } finally {
      fx.cleanup();
    }
  });

  test("respects custom confidence threshold", () => {
    const fx = makeFixture();
    try {
      writeLessons(fx, "builder", makeFile([]));

      // With default threshold (0.7), confidence 0.6 should be rejected
      writeCandidatesFile(
        {
          version: 1,
          promptVersion: "p1.distill.v1",
          updatedAt: "",
          candidates: [makeCandidate({ confidence: 0.6 })],
        },
        fx.root,
      );
      const result1 = gateCandidates({ root: fx.root, agents: ["builder"], dryRun: true });
      expect(result1.rejected).toBe(1);

      // With lower threshold (0.5), confidence 0.6 should be promoted
      writeCandidatesFile(
        {
          version: 1,
          promptVersion: "p1.distill.v1",
          updatedAt: "",
          candidates: [makeCandidate({ confidence: 0.6 })],
        },
        fx.root,
      );
      const result2 = gateCandidates({
        root: fx.root,
        agents: ["builder"],
        confidenceThreshold: 0.5,
        dryRun: true,
      });
      expect(result2.promoted).toBe(1);
    } finally {
      fx.cleanup();
    }
  });
});
