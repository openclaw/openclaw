import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  projectOpenAITools,
  reconcileOpenAICompletionsToolChoice,
  reconcileOpenAIResponsesToolChoice,
} from "./openai-tool-projection.js";
import { findOpenAIStrictToolProjectionDiagnostics } from "./openai-tool-schema.js";

const lookup = projectOpenAITools([{ name: "lookup", parameters: {} }]);
const responseFunction = (name: string) => ({ type: "function" as const, name });
const completionFunction = (name: string) => ({ type: "function" as const, function: { name } });
const custom = { type: "custom" as const, custom: { name: "shell" } };
function allowedCompletions(
  mode: "auto" | "required",
  tools: Array<ReturnType<typeof completionFunction> | typeof custom>,
) {
  return { type: "allowed_tools" as const, allowed_tools: { mode, tools } };
}

describe("OpenAI tool projection", () => {
  it("keeps healthy tools when sibling descriptors or schemas are unreadable", () => {
    const projection = projectOpenAITools([
      {
        get name(): never {
          throw new Error("name exploded");
        },
        parameters: {},
      },
      {
        name: "bad_schema",
        parameters: {
          type: "object",
          get properties(): never {
            throw new Error("properties exploded");
          },
        },
      },
      {
        name: "lookup",
        get description(): never {
          throw new Error("description exploded");
        },
        parameters: undefined,
      },
    ]);

    expect(projection.tools).toEqual([
      {
        toolIndex: 2,
        name: "lookup",
        parameters: {},
      },
    ]);
    expect(projection.diagnostics).toHaveLength(2);
    expect(findOpenAIStrictToolProjectionDiagnostics(projection)).toEqual([
      { toolIndex: 0, violations: ["tool[0].name is unreadable"] },
      {
        toolIndex: 1,
        toolName: "bad_schema",
        violations: ["bad_schema.parameters is not JSON-serializable"],
      },
    ]);
  });

  it("materializes pinned function choices after one name read", () => {
    let responsesNameReads = 0;
    let completionsNameReads = 0;
    const responsesChoice = {
      type: "function",
      get name() {
        responsesNameReads += 1;
        return responsesNameReads === 1 ? "lookup" : "broken";
      },
    };
    const completionsChoice = {
      type: "function",
      function: {
        get name() {
          completionsNameReads += 1;
          return completionsNameReads === 1 ? "lookup" : "broken";
        },
      },
    };

    expect(reconcileOpenAIResponsesToolChoice(responsesChoice as never, lookup)).toEqual({
      type: "function",
      name: "lookup",
    });
    expect(reconcileOpenAICompletionsToolChoice(completionsChoice as never, lookup)).toEqual({
      type: "function",
      function: { name: "lookup" },
    });
    expect(responsesNameReads).toBe(1);
    expect(completionsNameReads).toBe(1);
  });

  it("keeps literal reference examples while quarantining dynamic schema references", () => {
    const parameters = Type.Object(
      { document: Type.Record(Type.String(), Type.Unknown()) },
      { examples: [{ document: { $dynamicAnchor: "node", $dynamicRef: "#node" } }] },
    );
    const projection = projectOpenAITools([
      { name: "store_schema", parameters },
      {
        name: "dynamic",
        parameters: {
          type: "object",
          properties: {
            value: { $dynamicRef: "#value" },
          },
        },
      },
    ]);

    expect(projection.tools).toEqual([{ toolIndex: 0, name: "store_schema", parameters }]);
    expect(projection.diagnostics).toEqual([
      {
        toolIndex: 1,
        toolName: "dynamic",
        violations: ["dynamic.parameters.properties.value.$dynamicRef"],
      },
    ]);
    expect(
      reconcileOpenAIResponsesToolChoice(responseFunction("store_schema"), projection),
    ).toEqual(responseFunction("store_schema"));
  });

  it("classifies sparse descriptors as unreadable tools", () => {
    const tools: Array<{ name: string; parameters: Record<string, unknown> }> = [];
    tools.length = 1;

    expect(projectOpenAITools(tools)).toEqual({
      inputToolCount: 1,
      tools: [],
      diagnostics: [{ toolIndex: 0, violations: ["tool[0] is unreadable"] }],
    });
  });

  it("rejects pinned and required choices when their function tools are unavailable", () => {
    const projection = projectOpenAITools([
      {
        name: "broken",
        get parameters(): never {
          throw new Error("parameters exploded");
        },
      },
    ]);

    expect(() =>
      reconcileOpenAIResponsesToolChoice(responseFunction("broken"), projection),
    ).toThrow('requested unavailable tool "broken"');
    expect(() => reconcileOpenAIResponsesToolChoice("required", projection)).toThrow(
      "no tools survived schema conversion",
    );
    expect(() =>
      reconcileOpenAICompletionsToolChoice(completionFunction("broken"), projection),
    ).toThrow('requested unavailable tool "broken"');
    expect(() => reconcileOpenAICompletionsToolChoice("required", projection)).toThrow(
      "no tools survived schema conversion",
    );
  });

  it("filters official Responses allowed_tools without broadening access", () => {
    expect(
      reconcileOpenAIResponsesToolChoice(
        {
          type: "allowed_tools",
          mode: "required",
          tools: [
            responseFunction("broken"),
            responseFunction("lookup"),
            { type: "web_search_preview" },
          ],
        },
        lookup,
      ),
    ).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [responseFunction("lookup"), { type: "web_search_preview" }],
    });
  });

  it("filters official Chat Completions allowed_tools without broadening access", () => {
    expect(
      reconcileOpenAICompletionsToolChoice(
        allowedCompletions("required", [
          completionFunction("broken"),
          completionFunction("lookup"),
          custom,
        ]),
        lookup,
      ),
    ).toEqual(allowedCompletions("required", [completionFunction("lookup")]));
  });

  it("rejects unsupported top-level Chat Completions custom choices", () => {
    expect(() => reconcileOpenAICompletionsToolChoice(custom, lookup)).toThrow(
      "custom tool_choice is unsupported",
    );
  });

  it("disables an auto Chat Completions allowed_tools choice when none survive", () => {
    expect(
      reconcileOpenAICompletionsToolChoice(
        allowedCompletions("auto", [completionFunction("broken"), custom]),
        lookup,
      ),
    ).toBe("none");
  });

  it("preserves non-function Responses choices", () => {
    const projection = projectOpenAITools([]);

    expect(reconcileOpenAIResponsesToolChoice({ type: "web_search_preview" }, projection)).toEqual({
      type: "web_search_preview",
    });
  });
});
