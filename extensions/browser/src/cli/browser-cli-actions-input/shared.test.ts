import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { readActionsPayload, readFields } from "./shared.js";

function withInput<T>(bytes: string | Buffer, run: (file: string) => Promise<T>) {
  return withTempDir("openclaw-browser-input-", async (root) => {
    const file = path.join(root, "input.json");
    await fs.writeFile(file, bytes);
    return run(file);
  });
}

function readActionFile(size: number, symlink = false) {
  return withInput(Buffer.alloc(size, 0x20), async (file) => {
    if (symlink) {
      await fs.symlink(file, `${file}.link`);
    }
    return readActionsPayload({ actionsFile: symlink ? `${file}.link` : file });
  });
}

it.each(["fields", "actions"] as const)("rejects malformed UTF-8 in %s files", async (kind) => {
  const bytes = Buffer.from('[{"ref":"1","value":"\xff"}]', "latin1");
  await withInput(bytes, async (file) => {
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
  const iterator = vi.spyOn(process.stdin, Symbol.asyncIterator);
  iterator.mockImplementationOnce(async function* () {
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
it("throws descriptive error on empty fields", async () => {
  await expect(readFields({ fields: "" })).rejects.toThrow("fields are required");
});

it("preserves oversized fields files that normalize to a small request", async () => {
  await withInput(`[${" ".repeat(1_048_577)}{"ref":"1","value":"ok"}]`, async (fieldsFile) => {
    const fields = await readFields({ fieldsFile });
    expect(fields).toEqual([{ ref: "1", type: "text", value: "ok" }]);
  });
});
const maxBytes = 1_000_000;
const tooLarge = {
  code: "too-large",
  message: expect.stringContaining("Split the batch plan into smaller files"),
};
it.each(["at limit", "overflow", "malformed UTF-8"] as const)(
  "validates stdin bytes: %s",
  async (kind) => {
    const bytes =
      kind === "malformed UTF-8"
        ? Buffer.from([0xff])
        : Buffer.alloc(maxBytes + (kind === "overflow" ? 1 : 0), 0x20);
    const iterator = vi.spyOn(process.stdin, Symbol.asyncIterator);
    iterator.mockImplementationOnce(async function* () {
      yield bytes;
      return undefined;
    });
    // The iterator fixture must not destroy the runner's actual stdin on overflow.
    const destroy = vi.spyOn(process.stdin, "destroy").mockReturnValue(process.stdin);
    try {
      const result = readActionsPayload({ actionsFile: "-" });
      if (kind === "at limit") {
        expect(await result).toBe(bytes.toString("utf8"));
      } else {
        await expect(result).rejects.toMatchObject(
          kind === "overflow"
            ? tooLarge
            : { message: "--actions-file - stdin must be valid UTF-8." },
        );
      }
    } finally {
      iterator.mockRestore();
      destroy.mockRestore();
    }
  },
);
it("bounds action files with the same byte limit as stdin", async () => {
  await expect(readActionFile(maxBytes + 1)).rejects.toMatchObject(tooLarge);
  expect(Buffer.byteLength(await readActionFile(maxBytes))).toBe(maxBytes);
});

it("follows a symlinked action file to its bounded target", async () => {
  expect(Buffer.byteLength(await readActionFile(maxBytes, true))).toBe(maxBytes);
});
it("rejects an oversized symlinked action file target", async () => {
  await expect(readActionFile(maxBytes + 1, true)).rejects.toMatchObject(tooLarge);
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
