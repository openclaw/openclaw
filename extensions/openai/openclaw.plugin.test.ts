import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  providerAuthChoices?: Array<{
    provider?: string;
    method?: string;
    choiceLabel?: string;
    choiceHint?: string;
    choiceId?: string;
    deprecatedChoiceIds?: string[];
    groupHint?: string;
  }>;
};

describe("OpenAI plugin manifest", () => {
  it("keeps removed Codex CLI import auth choice as a deprecated browser-login alias", () => {
    const codexBrowserLogin = manifest.providerAuthChoices?.find(
      (choice) => choice.choiceId === "openai-codex",
    );

    expect(codexBrowserLogin?.deprecatedChoiceIds).toContain("openai-codex-import");
  });

  it("labels OpenAI API key and Codex auth choices without stale mixed OAuth wording", () => {
    const choices = manifest.providerAuthChoices ?? [];
    const codexBrowserLogin = choices.find((choice) => choice.choiceId === "openai-codex");
    const codexDeviceCode = choices.find(
      (choice) => choice.choiceId === "openai-codex-device-code",
    );
    const apiKey = choices.find(
      (choice) => choice.provider === "openai" && choice.method === "api-key",
    );

    expect(codexBrowserLogin).toMatchObject({
      choiceLabel: "OpenAI Codex Browser Login",
      choiceHint: "Sign in with OpenAI in your browser",
      groupHint: "API key + Codex auth",
    });
    expect(codexDeviceCode).toMatchObject({
      choiceLabel: "OpenAI Codex Device Pairing",
      choiceHint: "Pair in browser with a device code",
      groupHint: "API key + Codex auth",
    });
    expect(apiKey).toMatchObject({
      choiceLabel: "OpenAI API Key",
      groupHint: "API key + Codex auth",
    });
    expect(choices.map((choice) => choice.choiceLabel)).not.toContain(
      "OpenAI Codex (ChatGPT OAuth)",
    );
    expect(choices.map((choice) => choice.groupHint)).not.toContain("Codex OAuth + API key");
  });
});
