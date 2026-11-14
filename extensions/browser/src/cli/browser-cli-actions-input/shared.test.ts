import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { readActionsPayload, readFields } from "./shared.js";

function withInput<T>(bytes: string | Buffer, run: (file: string) => Promise<T>, symlink = false) {
  return withTempDir("openclaw-browser-input-", async (root) => {
    const file = path.join(root, "input.json");
    await fs.writeFile(file, bytes);
    if (symlink) {
      await fs.symlink(file, `${file}.link`);
    }
    return run(symlink ? `${file}.link` : file);
  });
}

function readActionFile(size: number, symlink = false) {
  return withInput(
    Buffer.alloc(size, 0x20),
    (actionsFile) => readActionsPayload({ actionsFile }),
    symlink,
  );
}

async function withStdin(chunks: Buffer[], run: () => Promise<void>, mockDestroy = false) {
  const iterator = vi
    .spyOn(process.stdin, Symbol.asyncIterator)
    .mockImplementationOnce(async function* () {
      yield* chunks;
      return undefined;
    });
  // Overflow must not destroy the runner's actual stdin.
  const destroy = mockDestroy
    ? vi.spyOn(process.stdin, "destroy").mockReturnValue(process.stdin)
    : undefined;
  try {
    await run();
  } finally {
    iterator.mockRestore();
    destroy?.mockRestore();
  }
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
  await withStdin([bytes.subarray(0, split), bytes.subarray(split)], async () => {
    expect(await readActionsPayload({ actionsFile: "-" })).toBe(text);
  });
});
it("throws descriptive error on empty fields", async () => {
  await expect(readFields({ fields: "" })).rejects.toThrow("fields are required");
});

it.each([false, true])(
  "preserves oversized Unicode fields files (symlink: %s)",
  async (symlink) => {
    await withInput(
      `[${" ".repeat(1_048_577)}{"ref":"1","value":"合法 😀"}]`,
      async (fieldsFile) => {
        expect(await readFields({ fieldsFile })).toEqual([
          { ref: "1", type: "text", value: "合法 😀" },
        ]);
      },
      symlink,
    );
  },
);

it.skipIf(process.platform === "win32").each([
  ["fields", false],
  ["fields", true],
  ["actions", false],
] as const)("rejects FIFO %s files (symlink: %s)", async (kind, symlink) => {
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
      const file = symlink ? `${fifoPath}.link` : fifoPath;
      await expect(
        kind === "fields"
          ? readFields({ fieldsFile: file })
          : readActionsPayload({ actionsFile: file }),
      ).rejects.toThrow("regular file");
    } finally {
      writer.kill("SIGKILL");
      await writerClosed;
    }
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
    await withStdin(
      [bytes],
      async () => {
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
      },
      true,
    );
  },
);
it.each([false, true])("bounds action files (symlink: %s)", async (symlink) => {
  await expect(readActionFile(maxBytes + 1, symlink)).rejects.toMatchObject(tooLarge);
  expect(Buffer.byteLength(await readActionFile(maxBytes, symlink))).toBe(maxBytes);
});
