import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  providerAuthChoices?: Array<{
    choiceId?: string;
    deprecatedChoiceIds?: string[];
  }>;
};

describe("OpenAI plugin manifest", () => {
  it("keeps removed Codex CLI import auth choice as a deprecated browser-login alias", () => {
    const codexBrowserLogin = manifest.providerAuthChoices?.find(
      (choice) => choice.choiceId === "openai-codex",
    );

    expect(codexBrowserLogin?.deprecatedChoiceIds).toContain("openai-codex-import");
  });
});
