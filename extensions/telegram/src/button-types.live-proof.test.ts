import { setConsoleSubsystemFilter, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildTelegramInteractiveButtons,
  buildTelegramPresentationButtons,
} from "./button-types.js";

const capturedWarnLines: string[] = [];
const originalConsoleWarn = console.warn;

beforeAll(() => {
  setLoggerOverride({ consoleLevel: "warn" });
  setConsoleSubsystemFilter(["telegram"]);

  console.warn = ((...args: unknown[]) => {
    capturedWarnLines.push(args.map(String).join(" "));
    originalConsoleWarn.call(console, ...args);
  }) as typeof console.warn;
});

afterAll(() => {
  console.warn = originalConsoleWarn;
});

describe("live proof: inline keyboard drop diagnostic", () => {
  it("buildTelegramPresentationButtons warns when presentation buttons exceed 64-byte callback limit", () => {
    capturedWarnLines.length = 0;

    buildTelegramPresentationButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Safe", value: "ok" },
            { label: "Overflow", value: "x".repeat(65) },
          ],
        },
      ],
    });

    expect(capturedWarnLines.length).toBeGreaterThanOrEqual(1);
    const line = capturedWarnLines.find((l) => l.includes("button(s) dropped"));
    expect(line).toBeDefined();
    expect(line).toContain("1 of 2");
    console.warn("  ✓ proof: presentation buttons drop warning emitted via real logger\n");
  });

  it("buildTelegramPresentationButtons warns with text-only suffix when all buttons dropped", () => {
    capturedWarnLines.length = 0;

    buildTelegramPresentationButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Overflow", value: "x".repeat(65) }],
        },
      ],
    });

    expect(capturedWarnLines.length).toBeGreaterThanOrEqual(1);
    const line = capturedWarnLines.find((l) => l.includes("button(s) dropped"));
    expect(line).toBeDefined();
    expect(line).toContain("text-only");
    console.warn("  ✓ proof: text-only suffix emitted via real logger\n");
  });

  it("buildTelegramInteractiveButtons warns when legacy interactive buttons exceed 64-byte limit", () => {
    capturedWarnLines.length = 0;

    buildTelegramInteractiveButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Safe", value: "keep" },
            { label: "Overflow", value: "x".repeat(65) },
          ],
        },
      ],
    });

    expect(capturedWarnLines.length).toBeGreaterThanOrEqual(1);
    const line = capturedWarnLines.find((l) => l.includes("button(s) dropped"));
    expect(line).toBeDefined();
    expect(line).toContain("1 of 2");
    console.warn("  ✓ proof: legacy interactive buttons drop warning emitted via real logger\n");
  });

  it("does not log when no buttons are dropped", () => {
    capturedWarnLines.length = 0;

    buildTelegramPresentationButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Safe", value: "ok" }],
        },
      ],
    });

    const dropped = capturedWarnLines.filter((l) => l.includes("button(s) dropped"));
    expect(dropped.length).toBe(0);
    console.warn("  ✓ proof: no false-positive warning emitted via real logger\n");
  });
});
