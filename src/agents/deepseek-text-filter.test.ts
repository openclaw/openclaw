import { describe, expect, it } from "vitest";
import { createDeepSeekTextEventFilter, createDeepSeekTextFilter } from "./deepseek-text-filter.js";

function filteredText(chunks: readonly string[]) {
  const filter = createDeepSeekTextFilter();
  return [...chunks.flatMap((chunk) => filter.push(chunk)), ...filter.flush()].join("");
}

describe("createDeepSeekTextFilter", () => {
  it.each([
    {
      name: "tool_use_error in visible text",
      chunks: [
        "before <｜DSML｜tool_use_error><tool_name>write</tool_name></｜DSML｜tool_use_error> after",
      ],
      expected: "before  after",
    },
    {
      name: "split open token",
      chunks: ["before ", "<｜DS", "ML｜tool_calls>body</｜DSML｜tool_calls>", " after"],
      expected: "before  after",
    },
    {
      name: "singular tool_call close",
      chunks: ["<|DSML|tool_call>read</|DSML|tool_call> visible"],
      expected: " visible",
    },
    {
      name: "singular open plural close",
      chunks: ["<|DS", "ML|tool_call>read\n", "</|DSML|tool_calls>"],
      expected: "",
    },
    {
      name: "unterminated block",
      chunks: ["visible <｜DSML｜tool_calls>partial body, no close"],
      expected: "visible ",
    },
    {
      name: "multiple blocks",
      chunks: [
        "a<｜DSML｜tool_use_error>x</｜DSML｜tool_use_error>b<｜DSML｜function_calls>y</｜DSML｜function_calls>c",
      ],
      expected: "abc",
    },
  ])("drops DSML: $name", ({ chunks, expected }) => {
    const text = filteredText(chunks);
    expect(text).toBe(expected);
    expect(text).not.toContain("DSML");
  });

  it("holds a partial open token until it can classify it", () => {
    const filter = createDeepSeekTextFilter();
    const mid = filter.push("safe text<｜DSM");
    expect(mid.join("")).toBe("safe text");

    const all = [
      ...mid,
      ...filter.push("L｜tool_calls>body</｜DSML｜tool_calls> done"),
      ...filter.flush(),
    ];
    expect(all.join("")).toBe("safe text done");
  });

  it("emits normal short text immediately", () => {
    const filter = createDeepSeekTextFilter();
    expect(filter.push("hello")).toEqual(["hello"]);
    expect(filter.flush()).toEqual([]);
  });

  it("emits recoverable events for tool-call wrapper spelling variants", () => {
    const filter = createDeepSeekTextEventFilter();
    expect(
      filter.push(
        '<|DSML|tool_call><|DSML|invoke name="read">{"path":"/tmp/x"}</|DSML|invoke></|DSML|tool_calls> after',
      ),
    ).toEqual([
      {
        type: "dsml",
        kind: "tool_call",
        body: '<|DSML|invoke name="read">{"path":"/tmp/x"}</|DSML|invoke>',
      },
      { type: "text", text: " after" },
    ]);
    expect(filter.flush()).toEqual([]);
  });

  it("strips mismatched DSML wrappers without emitting a recoverable event", () => {
    const filter = createDeepSeekTextEventFilter();
    expect(
      filter.push(
        '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/x"}</|DSML|invoke></|DSML|tool_use_error> after',
      ),
    ).toEqual([{ type: "text", text: " after" }]);
    expect(filter.flush()).toEqual([]);
  });

  it("drops oversized DSML bodies without retaining them as events", () => {
    const filter = createDeepSeekTextEventFilter();
    expect(filter.push("<|DSML|tool_calls>")).toEqual([]);
    expect(filter.push("x".repeat(260_000))).toEqual([]);
    expect(filter.push("</|DSML|tool_calls>tail")).toEqual([{ type: "text", text: "tail" }]);
    expect(filter.flush()).toEqual([]);
  });
});
