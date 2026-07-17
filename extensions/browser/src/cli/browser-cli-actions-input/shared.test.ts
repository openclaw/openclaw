// Browser tests cover shared plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readFields } from "./shared.js";

const BROWSER_FIELDS_FILE_MAX_BYTES = 1024 * 1024;

describe("readFields", () => {
  it.each([
    {
      name: "keeps explicit type",
      fields: '[{"ref":"6","type":"textbox","value":"hello"}]',
      expected: [{ ref: "6", type: "textbox", value: "hello" }],
    },
    {
      name: "defaults missing type to text",
      fields: '[{"ref":"7","value":"world"}]',
      expected: [{ ref: "7", type: "text", value: "world" }],
    },
    {
      name: "defaults blank type to text",
      fields: '[{"ref":"8","type":"   ","value":"blank"}]',
      expected: [{ ref: "8", type: "text", value: "blank" }],
    },
  ])("$name", async ({ fields, expected }) => {
    await expect(readFields({ fields })).resolves.toEqual(expected);
  });

  it("requires ref", async () => {
    await expect(readFields({ fields: '[{"type":"textbox","value":"world"}]' })).rejects.toThrow(
      "fields[0] must include ref",
    );
  });

  it("throws descriptive error on malformed JSON", async () => {
    await expect(readFields({ fields: "NOT JSON {{{" })).rejects.toThrow(
      "fields must be valid JSON.",
    );
  });

  it("throws descriptive error on empty fields", async () => {
    await expect(readFields({ fields: "" })).rejects.toThrow("fields are required");
  });

  it("reads valid fields from a file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-fields-"));
    try {
      const fieldsFile = path.join(dir, "fields.json");
      await fs.writeFile(fieldsFile, '[{"ref":"9","value":"from file"}]', "utf8");

      await expect(readFields({ fieldsFile })).resolves.toEqual([
        { ref: "9", type: "text", value: "from file" },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects oversized fields files before parsing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-fields-"));
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      const fieldsFile = path.join(dir, "fields.json");
      await fs.writeFile(fieldsFile, "x".repeat(BROWSER_FIELDS_FILE_MAX_BYTES + 1), "utf8");

      await expect(readFields({ fieldsFile })).rejects.toThrow(
        `fields file exceeds ${BROWSER_FIELDS_FILE_MAX_BYTES} bytes`,
      );
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
