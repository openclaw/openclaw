import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("telegram native command runtime deps import shape", () => {
  it("loads the edit-message helper as a static named export to avoid bundled namespace cycles", async () => {
    const source = await readFile(
      new URL("./bot-native-command-deps.runtime.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain('Promise<typeof import("./send.js")>');
    expect(source).not.toContain("loadTelegramSendRuntime");
    expect(source).not.toContain('import("./send.js")');
    expect(source).toContain('import { editMessageTelegram } from "./send.js";');
  });
});
