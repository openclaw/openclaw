import { expect, it, vi } from "vitest";
import {
  assertCodeModeResponsesToolSurface as assertSurface,
  enforceCodeModeResponsesToolSurface as enforceSurface,
  filterCodeModePayloadTools as filterTools,
  resolveCodeModeResponsesVisibleToolNames as resolveVisibleNames,
} from "./openai-transport-params.js";

function withThrowingGetter(field: string): Record<string, unknown> {
  return Object.defineProperty({}, field, {
    enumerable: true,
    get() {
      throw new Error(`unexpected ${field} getter`);
    },
  }) as Record<string, unknown>;
}
const named = (name: string) => ({ name });
const fn = (name: string) => ({ type: "function", name });
const nestedFn = (name: string) => ({ type: "function", function: named(name) });
const hosted = (type: string) => ({ type });
const grouped = (...names: string[]) => ({ functionDeclarations: names.map(named) });
const declaration = (name: string) => ({ name, parameters: { type: "object" } });
const payloadWith = (...tools: unknown[]) => ({ tools });
const visible = new Set(["exec", "wait", "computer"]);
const hostedTypes = new Set(["web_search"]);
function expectViolation(payload: unknown, allowed?: ReadonlySet<string>) {
  expect(() => assertSurface(payload, visible, allowed)).toThrow(/tool surface violation/);
}

it("uses only tool names declared in the current request", () => {
  const payload = payloadWith(
    named("exec"),
    { function: named("wait") },
    named("computer"),
    withThrowingGetter("name"),
    Object.create({ name: "rogue" }),
    null,
  );
  expect(
    resolveVisibleNames(payload as unknown as Parameters<typeof resolveVisibleNames>[0]),
  ).toEqual(new Set(["exec", "wait", "computer"]));
});
it.each(["functionDeclarations", "function_declarations"] as const)(
  "filters grouped %s without admitting provider-native tools",
  (field) => {
    const payload = payloadWith(
      fn("exec"),
      nestedFn("wait"),
      {
        [field]: [declaration("computer"), declaration("web_search"), withThrowingGetter("name")],
      },
      hosted("web_search"),
      withThrowingGetter("name"),
    );

    filterTools(payload, visible);

    expect(payload.tools).toEqual([
      fn("exec"),
      nestedFn("wait"),
      { [field]: [declaration("computer")] },
    ]);
  },
);

it("keeps only explicitly allowed hosted tools alongside visible client functions", () => {
  const payload = payloadWith(
    fn("exec"),
    fn("rogue"),
    hosted("web_search"),
    hosted("file_search"),
    { type: "web_search", name: "exec" },
    { type: "web_search", function: { name: "wait" } },
    { type: "web_search", functionDeclarations: [{ name: "exec" }] },
    fn("wait"),
  );

  filterTools(payload, visible, hostedTypes);
  enforceSurface(payload, visible, hostedTypes);

  expect(payload.tools).toEqual([fn("exec"), hosted("web_search"), fn("wait")]);
  expect(() => assertSurface(payload, visible, hostedTypes)).not.toThrow();
});

it("observes exact final-egress identities without a second payload parser", () => {
  const observer = vi.fn();
  const payload = payloadWith(
    fn("exec"),
    nestedFn("wait"),
    grouped("computer", "rogue"),
    hosted("web_search"),
    hosted("file_search"),
  );

  enforceSurface(payload, visible, hostedTypes, observer);

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
    const payload = payloadWith(named("exec"), named("wait"), {
      [field]: [named("exec"), named("computer")],
    });

    expectViolation(payload);

    enforceSurface(payload, visible);

    expect(payload.tools).toEqual([{ name: "exec" }, { name: "wait" }]);
    expect(() => assertSurface(payload, visible)).not.toThrow();
  },
);

it.each<[unknown[], ReadonlySet<string> | undefined]>([
  [[named("exec"), named("exec"), named("wait")], undefined],
  [[named("exec"), named("computer")], undefined],
  [[named("exec"), named("wait"), named("web_search")], undefined],
  [[fn("exec"), fn("wait"), hosted("web_search"), hosted("web_search")], hostedTypes],
  [[fn("exec"), fn("wait"), hosted("file_search")], hostedTypes],
])("rejects duplicate, missing, or undeclared tools: %j", (tools, allowed) => {
  expectViolation({ tools }, allowed);
});

it("fails closed when the asserted payload tools getter throws", () => {
  expectViolation(withThrowingGetter("tools"));
});
