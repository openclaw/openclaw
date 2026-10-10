// Browser tests cover shared plugin behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { readActionsPayload, readFields } from "./shared.js";

describe("browser JSON byte input", () => {
  it.each(["fields", "actions"] as const)("rejects malformed UTF-8 in %s files", async (kind) => {
    await withTempDir("openclaw-browser-utf8-", async (root) => {
      const file = path.join(root, "input.json");
      const bytes = Buffer.concat([
        Buffer.from('[{"ref":"1","value":"'),
        Buffer.from([0xff]),
        Buffer.from('"}]'),
      ]);
      await fs.writeFile(file, bytes);
      const result =
        kind === "fields"
          ? readFields({ fieldsFile: file })
          : readActionsPayload({ actionsFile: file });
      await expect(result).rejects.toThrow("must be valid UTF-8");
      expect(await fs.readFile(file)).toEqual(bytes);
    });
  });

  it.each(["fields", "actions"] as const)("preserves valid Unicode in %s files", async (kind) => {
    await withTempDir("openclaw-browser-utf8-", async (root) => {
      const file = path.join(root, "input.json");
      const text = '[{"ref":"1","value":"合法 � 😀"}]\r\n';
      await fs.writeFile(file, text);
      if (kind === "fields") {
        expect(await readFields({ fieldsFile: file })).toEqual([
          { ref: "1", type: "text", value: "合法 � 😀" },
        ]);
      } else {
        expect(await readActionsPayload({ actionsFile: file })).toBe(text);
      }
      expect(await fs.readFile(file, "utf8")).toBe(text);
    });
  });

  it("rejects malformed stdin bytes after bounded collection", async () => {
    const iterator = vi
      .spyOn(process.stdin, Symbol.asyncIterator)
      .mockImplementationOnce(async function* () {
        yield Buffer.from('[{"kind":"type","text":"');
        yield Buffer.from([0xe2, 0x82]);
        yield Buffer.from('"}]');
        return undefined;
      });
    try {
      await expect(readActionsPayload({ actionsFile: "-" })).rejects.toThrow("must be valid UTF-8");
    } finally {
      iterator.mockRestore();
    }
  });

  it("preserves valid stdin Unicode split across chunks", async () => {
    const text = '[{"kind":"type","text":"合法 � 😀"}]\r\n';
    const bytes = Buffer.from(text);
    const split = Buffer.byteLength(text.slice(0, text.indexOf("合"))) + 1;
    const iterator = vi
      .spyOn(process.stdin, Symbol.asyncIterator)
      .mockImplementationOnce(async function* () {
        yield bytes.subarray(0, split);
        yield bytes.subarray(split);
        return undefined;
      });
    try {
      expect(await readActionsPayload({ actionsFile: "-" })).toBe(text);
    } finally {
      iterator.mockRestore();
    }
  });
});

describe("readFields", () => {
  it("throws descriptive error on empty fields", async () => {
    await expect(readFields({ fields: "" })).rejects.toThrow("fields are required");
  });

  it("preserves oversized fields files that normalize to a small request", async () => {
    await withTempDir("openclaw-browser-fields-", async (tempDir) => {
      const fieldsPath = path.join(tempDir, "fields.json");
      await fs.writeFile(fieldsPath, `[${" ".repeat(1_048_577)}{"ref":"1","value":"ok"}]`);

      await expect(readFields({ fieldsFile: fieldsPath })).resolves.toEqual([
        { ref: "1", type: "text", value: "ok" },
      ]);
    });
  });
});

describe("readActionsPayload", () => {
  it("rejects conflicting inline and file actions before reading the file", async () => {
    await expect(
      readActionsPayload({ actions: "[]", actionsFile: "/tmp/openclaw-browser-actions.json" }),
    ).rejects.toThrow("Specify only one of --actions or --actions-file");
  });

  it("preserves inline actions larger than the file input ceiling", async () => {
    const actions = " ".repeat(1_000_001);
    await expect(readActionsPayload({ actions })).resolves.toBe(actions);
  });

  it("bounds action files with the same byte limit as stdin", async () => {
    const maxBytes = 1_000_000;
    await withTempDir("openclaw-browser-actions-", async (tempDir) => {
      const actionsPath = path.join(tempDir, "actions.json");
      await fs.writeFile(actionsPath, Buffer.alloc(maxBytes + 1, 0x20));
      await expect(readActionsPayload({ actionsFile: actionsPath })).rejects.toMatchObject({
        code: "too-large",
        message: expect.stringContaining("Split the batch plan into smaller files"),
      });

      await fs.writeFile(actionsPath, Buffer.alloc(maxBytes, 0x20));
      const payload = await readActionsPayload({ actionsFile: actionsPath });
      expect(Buffer.byteLength(payload)).toBe(maxBytes);
    });
  });

  it("follows a symlinked action file to its bounded target", async () => {
    const maxBytes = 1_000_000;
    await withTempDir("openclaw-browser-actions-", async (tempDir) => {
      const targetPath = path.join(tempDir, "actions-target.json");
      const linkPath = path.join(tempDir, "actions-link.json");
      await fs.writeFile(targetPath, Buffer.alloc(maxBytes, 0x20));
      await fs.symlink(targetPath, linkPath);

      const payload = await readActionsPayload({ actionsFile: linkPath });
      expect(Buffer.byteLength(payload)).toBe(maxBytes);
    });
  });

  it("rejects an oversized symlinked action file target", async () => {
    const maxBytes = 1_000_000;
    await withTempDir("openclaw-browser-actions-", async (tempDir) => {
      const targetPath = path.join(tempDir, "actions-target.json");
      const linkPath = path.join(tempDir, "actions-link.json");
      await fs.writeFile(targetPath, Buffer.alloc(maxBytes + 1, 0x20));
      await fs.symlink(targetPath, linkPath);

      await expect(readActionsPayload({ actionsFile: linkPath })).rejects.toMatchObject({
        code: "too-large",
        message: expect.stringContaining("Split the batch plan into smaller files"),
      });
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects FIFO action files without opening them",
    async () => {
      await withTempDir("openclaw-browser-actions-", async (tempDir) => {
        const fifoPath = path.join(tempDir, "actions.pipe");
        execFileSync("mkfifo", [fifoPath]);

        await expect(readActionsPayload({ actionsFile: fifoPath })).rejects.toThrow("regular file");
      });
    },
  );
});
