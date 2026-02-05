import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildArtifactRecallSection } from "./artifact-recall.js";
import { appendArtifactRegistryEntry } from "./artifact-registry.js";

describe("buildArtifactRecallSection", () => {
  it("renders recent artifacts with narrative", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "openclaw-artifact-recall-"));
    const artifactDir = path.join(dir, "artifacts");
    appendArtifactRegistryEntry({
      artifactDir,
      entry: {
        hash: "hash-1",
        sessionKey: "session-a",
        artifact: {
          id: "art_1",
          type: "tool-result",
          createdAt: new Date().toISOString(),
          sizeBytes: 12,
          summary: "first summary",
          path: path.join(artifactDir, "art_1.json"),
        },
      },
    });
    appendArtifactRegistryEntry({
      artifactDir,
      entry: {
        hash: "hash-2",
        sessionKey: "session-a",
        artifact: {
          id: "art_2",
          type: "tool-result",
          createdAt: new Date().toISOString(),
          sizeBytes: 12,
          summary: "second summary",
          path: path.join(artifactDir, "art_2.json"),
        },
      },
    });

    const section = buildArtifactRecallSection({
      sessionFile: path.join(dir, "session.json"),
      sessionKey: "session-a",
      config: {
        memory: {
          artifacts: {
            maxItems: 1,
            maxChars: 2000,
            narrativeMaxChars: 200,
          },
        },
      },
    });

    expect(section).toContain("## Artifact Recall");
    expect(section).toContain("### Recall Strategy");
    expect(section).toContain(
      "- Exact: read the artifact file by path when you need verbatim output.",
    );
    expect(section).toContain("second summary");
    expect(section).toContain("art_2");
  });

  it("caps recall output to the configured maxChars", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "openclaw-artifact-recall-"));
    const artifactDir = path.join(dir, "artifacts");
    appendArtifactRegistryEntry({
      artifactDir,
      entry: {
        hash: "hash-1",
        sessionKey: "session-a",
        artifact: {
          id: "art_1",
          type: "tool-result",
          createdAt: new Date().toISOString(),
          sizeBytes: 12,
          summary: "summary that is intentionally long to pressure the recall budget",
          path: path.join(artifactDir, "art_1.json"),
        },
      },
    });

    const maxChars = 180;
    const section = buildArtifactRecallSection({
      sessionFile: path.join(dir, "session.json"),
      sessionKey: "session-a",
      config: {
        memory: {
          artifacts: {
            maxItems: 1,
            maxChars,
            narrativeMaxChars: 200,
          },
        },
      },
    });

    expect(section).not.toBeNull();
    expect(section?.length).toBeLessThanOrEqual(maxChars);
    expect(section).toContain("## Artifact Recall");
  });

  it("returns null when disabled", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "openclaw-artifact-recall-"));
    const artifactDir = path.join(dir, "artifacts");
    appendArtifactRegistryEntry({
      artifactDir,
      entry: {
        hash: "hash-1",
        sessionKey: "session-a",
        artifact: {
          id: "art_1",
          type: "tool-result",
          createdAt: new Date().toISOString(),
          sizeBytes: 12,
          summary: "summary",
          path: path.join(artifactDir, "art_1.json"),
        },
      },
    });

    const section = buildArtifactRecallSection({
      sessionFile: path.join(dir, "session.json"),
      sessionKey: "session-a",
      config: {
        memory: {
          artifacts: {
            enabled: false,
          },
        },
      },
    });

    expect(section).toBeNull();
  });
});
