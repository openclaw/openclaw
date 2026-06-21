import { describe, expect, it } from "vitest";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { shouldRotateCodexAppServerStartupBinding, testing } from "./startup-binding.js";

function binding(
  currentTokens?: number,
  modelContextWindow = 100_000,
): CodexAppServerThreadBinding {
  return {
    threadId: "thread-1",
    cwd: "/workspace",
    ...(currentTokens === undefined
      ? {}
      : { nativeContextUsage: { currentTokens }, modelContextWindow }),
  };
}

function shouldRotate(
  current: CodexAppServerThreadBinding,
  overrides: Partial<Parameters<typeof shouldRotateCodexAppServerStartupBinding>[0]> = {},
) {
  return shouldRotateCodexAppServerStartupBinding({
    binding: current,
    config: undefined,
    ...overrides,
  });
}

describe("Codex app-server startup binding", () => {
  it("rotates at the last terminal native token fuse", () => {
    expect(shouldRotate(binding(80_000))).toBe(true);
  });

  it("reserves room for the projected turn", () => {
    expect(shouldRotate(binding(70_000), { projectedTurnTokens: 10_000 })).toBe(true);
  });

  it("uses the smaller prepared model and agent context windows", () => {
    expect(shouldRotate(binding(60_000, 200_000), { contextWindowTokens: 75_000 })).toBe(true);
  });

  it("keeps a thread without a terminal usage snapshot", () => {
    expect(shouldRotate(binding())).toBe(false);
  });

  it("keeps a thread below the fuse", () => {
    expect(shouldRotate(binding(79_999))).toBe(false);
  });

  it("honors configured reserve tokens and their floor", () => {
    expect(
      testing.resolveNativeThreadReserveTokens({
        agents: {
          defaults: {
            compaction: { reserveTokens: 5_000, reserveTokensFloor: 12_000 },
          },
        },
      } as never),
    ).toBe(12_000);
    expect(
      testing.resolveNativeThreadTokenFuse({
        modelContextWindow: 100_000,
        reserveTokens: 12_000,
      }),
    ).toBe(88_000);
  });
});
