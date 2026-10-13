import { describe, expect, it, vi } from "vitest";
import {
  assertCodeModeResponsesToolSurface,
  enforceCodeModeResponsesToolSurface,
  filterCodeModePayloadTools,
  resolveCodeModeResponsesVisibleToolNames,
} from "./openai-transport-params.js";

function withThrowingGetter(field: string): Record<string, unknown> {
  return Object.defineProperty({}, field, {
    enumerable: true,
    get() {
      throw new Error(`unexpected ${field} getter`);
    },
  }) as Record<string, unknown>;
}

describe("OpenAI Code Mode payload tool names", () => {
  it("uses only tool names declared in the current request", () => {
    expect(
      resolveCodeModeResponsesVisibleToolNames({
        tools: [
          { name: "exec" },
          { function: { name: "wait" } },
          { name: "computer" },
          withThrowingGetter("name"),
          Object.create({ name: "rogue" }),
          null,
        ],
      } as unknown as Parameters<typeof resolveCodeModeResponsesVisibleToolNames>[0]),
    ).toEqual(new Set(["exec", "wait", "computer"]));
  });
});

describe("OpenAI Code Mode payload tool filtering", () => {
  const visibleToolNames = new Set(["exec", "wait", "computer"]);

  it.each(["functionDeclarations", "function_declarations"] as const)(
    "filters grouped %s without admitting provider-native tools",
    (field) => {
      const payload: { tools: unknown[] } = {
        tools: [
          { type: "function", name: "exec" },
          { type: "function", function: { name: "wait" } },
          {
            [field]: [
              { name: "computer", parameters: { type: "object" } },
              { name: "web_search", parameters: { type: "object" } },
              withThrowingGetter("name"),
            ],
          },
          { type: "web_search" },
          withThrowingGetter("name"),
        ],
      };

      filterCodeModePayloadTools(payload, visibleToolNames);

      expect(payload.tools).toEqual([
        { type: "function", name: "exec" },
        { type: "function", function: { name: "wait" } },
        { [field]: [{ name: "computer", parameters: { type: "object" } }] },
      ]);
    },
  );

  it("keeps only explicitly allowed hosted tools alongside visible client functions", () => {
    const allowedHostedToolTypes = new Set(["web_search"]);
    const payload = {
      tools: [
        { type: "function", name: "exec" },
        { type: "function", name: "rogue" },
        { type: "web_search" },
        { type: "file_search" },
        { type: "web_search", name: "exec" },
        { type: "web_search", function: { name: "wait" } },
        { type: "web_search", functionDeclarations: [{ name: "exec" }] },
        { type: "function", name: "wait" },
      ],
    };

    filterCodeModePayloadTools(payload, visibleToolNames, allowedHostedToolTypes);
    enforceCodeModeResponsesToolSurface(payload, visibleToolNames, allowedHostedToolTypes);

    expect(payload.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "web_search" },
      { type: "function", name: "wait" },
    ]);
    expect(() =>
      assertCodeModeResponsesToolSurface(payload, visibleToolNames, allowedHostedToolTypes),
    ).not.toThrow();
  });

  it("observes exact final-egress identities without a second payload parser", () => {
    const observer = vi.fn();
    const payload = {
      tools: [
        { type: "function", name: "exec" },
        { type: "function", function: { name: "wait" } },
        {
          functionDeclarations: [{ name: "computer" }, { name: "rogue" }],
        },
        { type: "web_search" },
        { type: "file_search" },
      ],
    };

    enforceCodeModeResponsesToolSurface(
      payload,
      visibleToolNames,
      new Set(["web_search"]),
      observer,
    );

    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith({
      beforeToolIdentities: [
        "client:exec",
        "client:wait",
        "client:computer",
        "client:rogue",
        "hosted:web_search",
        "hosted:file_search",
      ],
      afterToolIdentities: ["client:exec", "client:wait", "hosted:web_search"],
    });
  });

  it.each(["functionDeclarations", "function_declarations"] as const)(
    "rejects and removes grouped %s from final OpenAI payloads",
    (field) => {
      const payload = {
        tools: [
          { name: "exec" },
          { name: "wait" },
          { [field]: [{ name: "exec" }, { name: "computer" }] },
        ],
      };

      expect(() => assertCodeModeResponsesToolSurface(payload, visibleToolNames)).toThrow(
        /tool surface violation/,
      );

      enforceCodeModeResponsesToolSurface(payload, visibleToolNames);

      expect(payload.tools).toEqual([{ name: "exec" }, { name: "wait" }]);
      expect(() => assertCodeModeResponsesToolSurface(payload, visibleToolNames)).not.toThrow();
    },
  );

  it.each([
    [{ name: "exec" }, { name: "exec" }, { name: "wait" }],
    [{ name: "exec" }, { name: "computer" }],
    [{ name: "exec" }, { name: "wait" }, { name: "web_search" }],
  ])("rejects duplicate, missing, or undeclared controls", (...tools) => {
    expect(() => assertCodeModeResponsesToolSurface({ tools }, visibleToolNames)).toThrow(
      /tool surface violation/,
    );
  });

  it.each([
    [
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
      { type: "web_search" },
      { type: "web_search" },
    ],
    [
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
      { type: "file_search" },
    ],
  ])("rejects duplicate or undeclared hosted tools", (...tools) => {
    expect(() =>
      assertCodeModeResponsesToolSurface({ tools }, visibleToolNames, new Set(["web_search"])),
    ).toThrow(/tool surface violation/);
  });

  it("fails closed when the asserted payload tools getter throws", () => {
    expect(() =>
      assertCodeModeResponsesToolSurface(withThrowingGetter("tools"), visibleToolNames),
    ).toThrow(/tool surface violation/);
  });
});
