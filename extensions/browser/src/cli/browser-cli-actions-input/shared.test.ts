// Browser tests cover shared plugin behavior.
import { execFileSync, spawn } from "node:child_process";
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

async function withInput(content: string, run: (file: string) => Promise<void>) {
  await withTempDir("browser-fields", async (root) => {
    const file = path.join(root, "fields.json");
    await fs.writeFile(file, content);
    await run(file);
  });
}
it.each([false, true])(
  "preserves oversized Unicode fields files (symlink: %s)",
  async (symlink) => {
    await withInput(`[${" ".repeat(1_048_577)}{"ref":"1","value":"合法 😀"}]`, async (file) => {
      if (symlink) {
        await fs.symlink(file, `${file}.link`);
      }
      const fields = await readFields({ fieldsFile: symlink ? `${file}.link` : file });
      expect(fields).toEqual([{ ref: "1", type: "text", value: "合法 😀" }]);
    });
  },
);

it.skipIf(process.platform === "win32").each([false, true])(
  "rejects FIFO fields files (symlink: %s)",
  async (symlink) => {
    await withTempDir("openclaw-browser-fields-", async (tempDir) => {
      const fifoPath = path.join(tempDir, "fields.pipe");
      execFileSync("mkfifo", [fifoPath]);
      if (symlink) {
        await fs.symlink(fifoPath, `${fifoPath}.link`);
      }
      // A writer lets a regressed reader finish instead of stranding the test runner.
      const writer = spawn(
        process.execPath,
        ["-e", "require('node:fs').writeFileSync(process.argv[1], '[]')", fifoPath],
        { stdio: "ignore" },
      );
      const writerClosed = new Promise((resolve) => {
        writer.once("close", resolve);
      });
      try {
        await expect(
          readFields({ fieldsFile: symlink ? `${fifoPath}.link` : fifoPath }),
        ).rejects.toThrow("regular file");
      } finally {
        writer.kill("SIGKILL");
        await writerClosed;
      }
    });
  },
);
