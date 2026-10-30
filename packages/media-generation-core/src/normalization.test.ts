import { expect, it } from "vitest";
import {
  normalizeDurationToClosestMax,
  resolveClosestAspectRatio,
  resolveClosestResolution,
  resolveClosestSize,
} from "./normalization.js";

type GeometryCase = {
  name: string;
  normalize: (values: string[]) => string | undefined;
  values: string[];
  expected: string | undefined;
};
it.each`
  name                  | normalize                                                                                                                 | values                                     | expected
  ${"unsafe size"}      | ${(supportedSizes: string[]) => resolveClosestSize({ requestedSize: "9007199254740993x3", supportedSizes })}              | ${["1024x1024", "1536x1024"]}              | ${undefined}
  ${"closest size"}     | ${(supportedSizes: string[]) => resolveClosestSize({ requestedSize: "1792x1024", supportedSizes })}                       | ${["1024x1024", "1024x1536", "1536x1024"]} | ${"1536x1024"}
  ${"resolution units"} | ${(supportedResolutions: string[]) => resolveClosestResolution({ requestedResolution: "4K", supportedResolutions })}      | ${["768P", "1080P"]}                       | ${undefined}
  ${"ratio tie"}        | ${(supportedAspectRatios: string[]) => resolveClosestAspectRatio({ requestedAspectRatio: "3:3", supportedAspectRatios })} | ${["invalid", "2:2", "1:1"]}               | ${"1:1"}
  ${"size tie"}         | ${(supportedSizes: string[]) => resolveClosestSize({ requestedAspectRatio: "1:1", supportedSizes })}                      | ${["invalid", "128x128", "64x64"]}         | ${"64x64"}
  ${"resolution tie"}   | ${(supportedResolutions: string[]) => resolveClosestResolution({ requestedResolution: "480P", supportedResolutions })}    | ${["invalid", "360P", "600P"]}             | ${"600P"}
`(
  "normalizes $name independent of provider order",
  ({ normalize, values, expected }: GeometryCase) => {
    for (const ordered of [values, values.toReversed()]) {
      expect(normalize(ordered)).toBe(expected);
    }
  },
);

it("clamps durations to the closest supported max", () => {
  expect(normalizeDurationToClosestMax(12, 8)).toBe(8);
  expect(normalizeDurationToClosestMax(6, 8)).toBe(6);
});
