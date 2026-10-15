import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexSessionMeta } from "./session-catalog-provenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const meta = (id = "source", provider = "native-a") => ({
  type: "session_meta",
  payload: { id, model_provider: provider, dynamic_tools: [] },
});
const encode = (records: unknown[]) =>
  Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
async function fixture(records: unknown[], compressed = false) {
  const tempDir = await fs.realpath(tempDirs.make("codex-snapshot-"));
  const dir = path.join(tempDir, "sessions");
  await fs.mkdir(dir);
  const rolloutPath = path.join(dir, "rollout.jsonl");
  const selectedPath = compressed ? `${rolloutPath}.zst` : rolloutPath;
  const write = (bytes: Buffer) =>
    fs.writeFile(selectedPath, compressed ? zstdCompressSync(bytes) : bytes);
  await write(encode(records));
  return {
    dir,
    rolloutPath,
    selectedPath,
    write,
    read: async () => {
      const metadata = await readCodexSessionMeta(dir, rolloutPath, "source", {
        canonicalSource: true,
      });
      if (!metadata) {
        throw new Error("Rollout metadata could not be verified");
      }
      return metadata;
    },
  };
}

describe("bounded native rollout metadata", () => {
  it("keeps canonicalized catalog roots distinct from canonical source admission", async () => {
    const f = await fixture([meta()]);
    const alias = `${f.dir}.link`;
    await fs.symlink(f.dir, alias);
    const rolloutPath = path.join(alias, "rollout.jsonl");
    await expect(readCodexSessionMeta(alias, rolloutPath, "source")).resolves.toEqual(
      meta().payload,
    );
    await expect(
      readCodexSessionMeta(alias, rolloutPath, "source", { canonicalSource: true }),
    ).resolves.toBeUndefined();
  });

  it.each(["large history", "large decoder window"])(
    "keeps ordinary catalog metadata readable with %s",
    async (size) => {
      const f = await fixture([meta()], true);
      const history =
        size === "large history"
          ? randomBytes(9 * 1024 * 1024).toString("base64")
          : "x".repeat(33 * 1024 * 1024);
      await fs.writeFile(
        f.selectedPath,
        zstdCompressSync(encode([meta(), { type: "event_msg", payload: history }]), {
          params: { [constants.ZSTD_c_windowLog]: 26 },
        }),
      );
      await expect(readCodexSessionMeta(f.dir, f.rolloutPath, "source")).resolves.toEqual(
        meta().payload,
      );
      await expect(f.read()).rejects.toThrow();
    },
  );

  it("prefers the exact plain file", async () => {
    const f = await fixture([meta("source", "plain")]);
    await fs.writeFile(
      `${f.rolloutPath}.zst`,
      zstdCompressSync(encode([meta("source", "compressed")])),
    );
    expect((await f.read()).model_provider).toBe("plain");
  });

  it.each([
    "wrong identity",
    "incomplete header",
    "hardlink",
    "symlink",
    "root symlink",
    "outside root",
  ])("fails closed for %s without selecting a fallback", async (fault) => {
    const f = await fixture([meta()]);
    await fs.writeFile(
      `${f.rolloutPath}.zst`,
      zstdCompressSync(encode([meta("source", "fallback")])),
    );
    if (fault === "wrong identity") {
      await f.write(encode([meta("wrong")]));
    }
    if (fault === "incomplete header") {
      await f.write(Buffer.from('{"type":'));
    }
    if (fault === "hardlink") {
      await fs.link(f.rolloutPath, `${f.rolloutPath}.link`);
    }
    if (fault === "symlink") {
      await fs.rename(f.rolloutPath, `${f.rolloutPath}.real`);
      await fs.symlink(`${f.rolloutPath}.real`, f.rolloutPath);
    }
    if (fault === "root symlink") {
      await fs.rename(f.dir, `${f.dir}.real`);
      await fs.symlink(`${f.dir}.real`, f.dir);
    }
    const read =
      fault === "outside root"
        ? async () => {
            if (!(await readCodexSessionMeta(path.join(f.dir, "child"), f.rolloutPath, "source"))) {
              throw new Error("Rollout metadata could not be verified");
            }
          }
        : f.read;
    if (fault === "outside root") {
      await fs.mkdir(path.join(f.dir, "child"));
    }
    await expect(read()).rejects.toThrow();
  });

  it.each([true])(
    "rejects invalid header UTF-8 without contaminating the next read (compressed=%s)",
    async (compressed) => {
      const invalid = await fixture([meta()], compressed);
      await invalid.write(Buffer.from([0xff, 10]));
      await expect(invalid.read()).rejects.toThrow();
      const valid = await fixture([meta()], compressed);
      await expect(valid.read()).resolves.toEqual(meta().payload);
    },
  );

  it.each(["input limit", "header limit"])("rejects compressed %s", async (fault) => {
    const f = await fixture([meta()], true);
    if (fault === "input limit") {
      await fs.appendFile(f.selectedPath, Buffer.alloc(8 * 1024 * 1024));
    } else {
      await f.write(encode([meta("source", "x".repeat(1024 * 1024))]));
    }
    await expect(f.read()).rejects.toThrow();
  });
});
