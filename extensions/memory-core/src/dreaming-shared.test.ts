// Memory Core tests cover dreaming shared plugin behavior.
import { describe, expect, it } from "vitest";
import { includesSystemEventToken } from "./dreaming-shared.js";

const TOKEN = "__openclaw_memory_core_short_term_promotion_dream__";

describe("includesSystemEventToken", () => {
  it("matches the bare token", () => {
    expect(includesSystemEventToken(TOKEN, TOKEN)).toBe(true);
  });

  it("matches a token wrapped by an isolated-cron `[cron:<id>]` prefix", () => {
    expect(includesSystemEventToken(`[cron:abc-123] ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("matches the token on its own line within multiline content", () => {
    expect(includesSystemEventToken(`leading text\n${TOKEN}\ntrailing`, TOKEN)).toBe(true);
  });

  it("does NOT match a user message that merely embeds the token mid-sentence", () => {
    expect(
      includesSystemEventToken(`please tell me about ${TOKEN} when you have time`, TOKEN),
    ).toBe(false);
  });

  it("does NOT match a user message with the token in a code-fence-style block", () => {
    expect(
      includesSystemEventToken(`here is a snippet:\n\`${TOKEN}\`\nwhat does that do?`, TOKEN),
    ).toBe(false);
  });

  it("does NOT match an arbitrary wrapper the runtime does not produce", () => {
    expect(includesSystemEventToken(`[somewrap] ${TOKEN}`, TOKEN)).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(includesSystemEventToken("", TOKEN)).toBe(false);
    expect(includesSystemEventToken(TOKEN, "")).toBe(false);
    expect(includesSystemEventToken("   ", TOKEN)).toBe(false);
  });
});

describe("includesSystemEventToken — legacy dreaming tokens", () => {
  const LEGACY_LIGHT = "__openclaw_memory_core_light_sleep__";
  const LEGACY_REM = "__openclaw_memory_core_rem_sleep__";

  it("matches legacy light sleep token", () => {
    expect(includesSystemEventToken(LEGACY_LIGHT, LEGACY_LIGHT)).toBe(true);
  });

  it("matches legacy REM sleep token", () => {
    expect(includesSystemEventToken(LEGACY_REM, LEGACY_REM)).toBe(true);
  });

  it("matches legacy light sleep token in multi-line body", () => {
    expect(
      includesSystemEventToken(`some prefix\n${LEGACY_LIGHT}\nsome suffix`, LEGACY_LIGHT),
    ).toBe(true);
  });

  it("matches legacy REM sleep token in multi-line body", () => {
    expect(includesSystemEventToken(`some prefix\n${LEGACY_REM}\nsome suffix`, LEGACY_REM)).toBe(
      true,
    );
  });

  it("matches legacy light sleep token with cron prefix", () => {
    expect(includesSystemEventToken(`[cron:abc123] ${LEGACY_LIGHT}`, LEGACY_LIGHT)).toBe(true);
  });

  it("does not match managed dreaming token as legacy", () => {
    expect(includesSystemEventToken(LEGACY_LIGHT, TOKEN)).toBe(false);
  });

  it("does not match trivial embedding of legacy token", () => {
    expect(includesSystemEventToken(`what is ${LEGACY_LIGHT}?`, LEGACY_LIGHT)).toBe(false);
  });
});
