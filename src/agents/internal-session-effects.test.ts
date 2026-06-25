// Covers private transcript preparation for internal agent side effects.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  prepareInternalSessionEffectsTranscript,
  removeInternalSessionEffectsTranscript,
} from "./internal-session-effects.js";

describe("prepareInternalSessionEffectsTranscript", () => {
  it("creates a private transcript even without a visible source file", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
        const sessionFile = await prepareInternalSessionEffectsTranscript({
          runId: "run/with space",
        });

        // The run id is filesystem-normalized and the transcript is private
        // because internal side effects may contain hidden agent context.
        expect(sessionFile).toBe(path.join(dir, "internal-agent-runs", "run_with_space.jsonl"));
        expect(await fs.readFile(sessionFile, "utf8")).toBe("");
        expect((await fs.stat(sessionFile)).mode & 0o777).toBe(0o600);

        await removeInternalSessionEffectsTranscript(sessionFile);

        await expect(fs.stat(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
      });
    });
  });

  it("copies a visible source transcript into a private transcript", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
        const sourceFile = path.join(dir, "visible-session.jsonl");
        await fs.writeFile(sourceFile, '{"role":"assistant","content":"done"}\n', {
          mode: 0o644,
        });

        const sessionFile = await prepareInternalSessionEffectsTranscript({
          sessionFile: sourceFile,
          runId: "run-copy",
        });

        expect(await fs.readFile(sessionFile, "utf8")).toBe(
          '{"role":"assistant","content":"done"}\n',
        );
        expect((await fs.stat(sessionFile)).mode & 0o777).toBe(0o600);
      });
    });
  });

  it("copies a SQLite source transcript into a private transcript", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
        const storePath = path.join(dir, "sessions.json");
        const scope = {
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          storePath,
        };
        await upsertSessionEntry(scope, { sessionId: "session-1", updatedAt: 1 });
        await appendTranscriptMessage(scope, {
          cwd: dir,
          message: {
            content: "stored",
            role: "assistant",
            timestamp: 2,
          },
        });

        const sessionFile = await prepareInternalSessionEffectsTranscript({
          sessionFile: formatSqliteSessionFileMarker({
            agentId: "main",
            sessionId: "session-1",
            storePath,
          }),
          runId: "run-sqlite-source",
        });

        const privateTranscript = await fs.readFile(sessionFile, "utf8");
        expect(privateTranscript).toContain('"role":"assistant"');
        expect(privateTranscript).toContain('"content":"stored"');
        expect((await fs.stat(sessionFile)).mode & 0o777).toBe(0o600);
      });
    });
  });

  it("creates an empty private transcript when the visible source is missing", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
        const sessionFile = await prepareInternalSessionEffectsTranscript({
          sessionFile: path.join(dir, "missing-session.jsonl"),
          runId: "run-missing-source",
        });

        expect(await fs.readFile(sessionFile, "utf8")).toBe("");
        expect((await fs.stat(sessionFile)).mode & 0o777).toBe(0o600);
      });
    });
  });
});
