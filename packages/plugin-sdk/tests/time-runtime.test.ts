import { createRequire } from "node:module";
import { expect, it } from "vitest";

it.each([Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
  "keeps delayed plugin work alive for an oversized deadline of %s",
  async (timeoutMs) => {
    const { raceWithTimeout }: typeof import("@openclaw/plugin-sdk/time-runtime") = await import(
      createRequire(import.meta.url).resolve("@openclaw/plugin-sdk/time-runtime")
    );
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on("warning", onWarning);
    try {
      const delayedPluginWork = new Promise<string>((resolve) => {
        setTimeout(() => resolve("done"), 20);
      });

      await expect(raceWithTimeout(delayedPluginWork, timeoutMs, () => "expired")).resolves.toBe(
        "done",
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(warnings.filter((warning) => warning.name === "TimeoutOverflowWarning")).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  },
);
