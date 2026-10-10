import { Command } from "commander";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { zoomMeetingsPlugin } from "../index.js";

const resolveZoomMeetingsConfig = zoomMeetingsPlugin.config.resolveConfig;

describe("Zoom meetings CLI", () => {
  it("exposes the same bounded timeout on both live probes", async () => {
    const program = new Command();
    (await zoomMeetingsPlugin.loadCli())({ program, config: resolveZoomMeetingsConfig({}) });
    const root = program.commands.find((command) => command.name() === "zoommeetings");

    for (const name of ["test-speech", "test-listen"]) {
      const probe = root?.commands.find((command) => command.name() === name);
      expect(probe?.options.map((option) => option.long)).toContain("--timeout-ms");
    }
  });

  it.each([
    [{}, false, undefined, 150_000],
    [{}, true, undefined, 180_000],
    [{}, true, 10_000, 160_000],
    [{ joinTimeoutMs: 120_000, waitForInCallMs: 40_000 }, true, undefined, 430_000],
    [
      { joinTimeoutMs: Number.MAX_VALUE, waitForInCallMs: Number.MAX_VALUE },
      true,
      Number.MAX_VALUE,
      MAX_TIMER_TIMEOUT_MS,
    ],
  ] as const)(
    "adds the post-join probe budget to the gateway deadline (%#)",
    (chrome, probe, requestedTimeoutMs, expected) => {
      expect(
        zoomMeetingsPlugin.resolveCliGatewayTimeoutMs(resolveZoomMeetingsConfig({ chrome }), {
          probe,
          requestedTimeoutMs,
        }),
      ).toBe(expected);
    },
  );
});
