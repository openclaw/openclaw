import { expect, it, vi } from "vitest";
import { styleHealthChannelLine } from "./health-style.js";

vi.mock("./theme.js", () => ({
  theme: new Proxy(
    {},
    {
      get: (_target, key) => (value: string) => `<${String(key)}>${value}</${String(key)}>`,
    },
  ),
}));

it.each([
  ["Channel: FaIlEd (retry)", "Channel: <error>FaIlEd</error> (retry)"],
  ["Loop: DEGRADED for 2s", "Loop: <warn>DEGRADED</warn> for 2s"],
  ["Channel: okay", "Channel: <success>ok</success>ay"],
  ["Channel:\tNOT CONFIGURED  ", "Channel: <muted>NOT CONFIGURED</muted>  "],
])("styleHealthChannelLine styles only the status prefix in %s", (line, expected) => {
  expect(styleHealthChannelLine(line, true)).toBe(expected);
});

it.each([
  ["Channel:\tfailed", false],
  ["no colon", true],
  ["Channel:\tstatus unknown", true],
  ["Channel:   ", true],
] as const)("styleHealthChannelLine preserves passthrough bytes for %s", (line, rich) => {
  expect(styleHealthChannelLine(line, rich)).toBe(line);
});
