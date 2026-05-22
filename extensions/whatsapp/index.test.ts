import { assertBundledChannelEntries } from "openclaw/plugin-sdk/channel-test-helpers";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("whatsapp bundled entries", () => {
  assertBundledChannelEntries({
    entry,
    expectedId: "whatsapp",
    expectedName: "WhatsApp",
    setupEntry,
  });

  it("registers runtime through the narrow setter entrypoint", () => {
    return expect(readFile(new URL("./index.ts", import.meta.url), "utf8")).resolves.toContain(
      'specifier: "./runtime-setter-api.js"',
    );
  });
});
