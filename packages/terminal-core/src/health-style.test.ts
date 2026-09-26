import { describe, expect, it, vi } from "vitest";
import { styleHealthChannelLine } from "./health-style.js";

const { colorReads } = vi.hoisted(() => ({ colorReads: [] as string[] }));
vi.mock("./theme.js", () => ({
  theme: new Proxy(
    {},
    {
      get: (_target, key) => {
        colorReads.push(String(key));
        return (value: string) => `<${String(key)}>${value}</${String(key)}>`;
      },
    },
  ),
}));

describe("styleHealthChannelLine", () => {
  it.each([
    ["Channel: FaIlEd (retry)", "Channel: <error>FaIlEd</error> (retry)", "error"],
    ["Loop: DEGRADED for 2s", "Loop: <warn>DEGRADED</warn> for 2s", "warn"],
    ["Channel: okay", "Channel: <success>ok</success>ay", "success"],
    ["Channel: Linked: detail", "Channel: <success>Linked</success>: detail", "success"],
    ["Channel: configured", "Channel: <success>configured</success>", "success"],
    ["Channel: not linked", "Channel: <warn>not linked</warn>", "warn"],
    ["Channel:\tNOT CONFIGURED  ", "Channel: <muted>NOT CONFIGURED</muted>  ", "muted"],
    ["Channel: unknown 🚦", "Channel: <warn>unknown</warn> 🚦", "warn"],
  ])("styles only the status prefix in %s", (line, expected, color) => {
    expect(colorReads).toEqual([]);
    expect(styleHealthChannelLine(line, true)).toBe(expected);
    expect(colorReads.splice(0)).toEqual([color]);
  });

  it.each([
    ["Channel:\tfailed", false],
    ["no colon", true],
    ["Channel:\tstatus unknown", true],
    ["Channel:   ", true],
  ] as const)("preserves passthrough bytes without reading colors for %s", (line, rich) => {
    expect(styleHealthChannelLine(line, rich)).toBe(line);
    expect(colorReads).toEqual([]);
  });
});
