import { describe, expect, it, vi } from "vitest";
import type { StructuredInputCompilerOptions } from "./structured-input-boundary.js";
import {
  compileStructuredInputForm,
  compileStructuredInputUrl,
  snapshotStructuredInput,
  type StructuredInputCompileResult,
} from "./structured-input.js";

const baseOptions: StructuredInputCompilerOptions = {
  protocolName: "test",
  allowEmptyForm: true,
  minimumChoiceCount: 1,
  metadata: { secretPath: ["isSecret"] },
};
const rich = { ...baseOptions, allowRichForms: true };
const string = (extra: Record<string, unknown> = {}) => ({ type: "string", ...extra });
const strings = (extra: Record<string, unknown> = {}, item = string()) => ({
  type: "array",
  items: item,
  ...extra,
});
const resourceField = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  string({ format: "uri", "x-openai-input": input, ...extra });
const resourceFields = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  strings({ "x-openai-input": input, ...extra }, string({ format: "uri" }));
const previewResource = (target: Record<string, unknown>) => ({
  uri: "cad://parts/washer",
  name: "Washer",
  _meta: { "openai/preview": { target } },
});
const richCompile = (properties: Record<string, unknown>, required: string[] = []) =>
  compile(properties, required, rich);
const urlInput = (url: string) =>
  compileStructuredInputUrl({
    url,
    elicitationId: "auth-1",
    message: "Review authorization",
    fallbackMessage: "Review URL",
    protocolName: "test",
  });

function compile(
  properties: Record<string, unknown>,
  required: string[] = [],
  options = baseOptions,
  message = "Complete the profile",
): StructuredInputCompileResult {
  return compileStructuredInputForm({
    schema: snapshotStructuredInput(
      { type: "object", properties, required },
      { richForm: options.allowRichForms },
    ),
    message,
    fallbackMessage: "Input requested",
    options,
  });
}

function requireForm(result: StructuredInputCompileResult) {
  if (result.kind !== "ready" || result.plan.kind !== "form") {
    throw new Error("expected form plan");
  }
  return result.plan;
}

function decodeForm(
  result: StructuredInputCompileResult,
  answers: Record<string, string[]>,
): Record<string, unknown> | string {
  const plan = requireForm(result);
  const entries: Array<[string, unknown]> = [];
  for (const field of plan.fields) {
    const decoded = field.decode(answers[field.question.id] ?? []);
    if (decoded.kind === "invalid") {
      return decoded.message;
    }
    if (decoded.kind === "present") {
      entries.push(...decoded.entries);
    }
  }
  return Object.fromEntries(entries);
}

describe("structured input compiler", () => {
  it("preserves bounded multiline reference text in negotiated rich informational forms", () => {
    const message =
      "Reference dimensions and manufacturing notes. ".repeat(144) +
      "\r\n\r\n\n\tChoose Allow to continue.";
    expect(message.length).toBeGreaterThan(1024);
    const plan = requireForm(compile({}, [], rich, message));
    expect(plan).toMatchObject({ kind: "form", intro: message, fields: [] });
    expect(compile({}, [], baseOptions, message).kind).toBe("unsupported");
    expect(compile({}, [], rich, "x".repeat(65_537)).kind).toBe("unsupported");
  });

  it.each(["\u0000", "\u001b", "\u202e", "\u2066"])(
    "still rejects unsafe controls in rich display text (%j)",
    (control) => {
      expect(
        compileStructuredInputForm({
          schema: { type: "object", properties: {} },
          message: "Reference\n" + control + "hidden text",
          fallbackMessage: "Reference",
          options: { ...baseOptions, allowRichForms: true },
        }).kind,
      ).toBe("unsupported");
    },
  );
  it("projects bounded primitive fields and decodes defaults, choices, and multi-select", () => {
    const result = compile(
      {
        "Display Name": string({ minLength: 2, maxLength: 20 }),
        contact: string({ format: "email" }),
        theme: string({
          oneOf: [
            { const: "day", title: "Day" },
            { const: "night", title: "Night", description: "Use dark colors" },
          ],
        }),
        enabled: { type: "boolean" },
        count: { type: "integer", minimum: 1, maximum: 9 },
        tags: strings({ minItems: 1, maxItems: 2 }, string({ enum: ["Red", "Blue", "Green"] })),
        score: { type: "number", default: 1.5 },
        optional: string(),
      },
      ["Display Name", "contact", "theme", "enabled", "count", "tags"],
    );
    const plan = requireForm(result);
    expect(plan.fields.map((field) => field.question.id)).toEqual(
      "display_name contact theme enabled count tags score optional".split(" "),
    );
    expect(plan.fields[2]?.question.options).toEqual([
      { label: "Day" },
      { label: "Night", description: "Use dark colors" },
    ]);
    expect(
      decodeForm(result, {
        display_name: ["Ada"],
        contact: ["ada@example.com"],
        theme: ["Night"],
        enabled: ["Yes"],
        count: ["7"],
        tags: ["Red", "Blue"],
        score: [],
        optional: [],
      }),
    ).toEqual({
      "Display Name": "Ada",
      contact: "ada@example.com",
      theme: "night",
      enabled: true,
      count: 7,
      tags: ["Red", "Blue"],
      score: 1.5,
    });
  });

  it("normalizes colliding ids and preserves __proto__ as inert accepted content", () => {
    const keys = ["Field Name", "field-name", "__proto__"];
    const result = compile(Object.fromEntries(keys.map((key) => [key, string()])), keys);
    expect(requireForm(result).fields.map((field) => field.question.id)).toEqual([
      "field_name",
      "field_name_2",
      "proto",
    ]);
    const decoded = decodeForm(result, {
      field_name: ["One"],
      field_name_2: ["Two"],
      proto: ["safe"],
    });
    expect(decoded).toMatchObject({ "Field Name": "One", "field-name": "Two" });
    expect(Object.hasOwn(decoded as object, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value).toBe("safe");
  });

  it("extracts only configured secret metadata and maps codex-acp Other fields", () => {
    const nestedOptions = {
      ...baseOptions,
      metadata: {
        secretPath: ["_meta", "codex", "isSecret"],
        otherAnswerPath: ["_meta", "codex", "isOtherAnswer"],
        otherQuestionIdPath: ["_meta", "codex", "questionId"],
      },
    };
    const result = compile(
      {
        mode: string({
          oneOf: [
            { const: "fast", title: " Fast " },
            { const: "safe", title: "Safe" },
          ],
          _meta: { codex: { isSecret: false } },
        }),
        mode__other: string({
          _meta: {
            codex: { questionId: "mode", isOtherAnswer: true, isSecret: true },
          },
        }),
        password: string(),
      },
      [],
      nestedOptions,
    );
    expect(requireForm(result).fields.map((field) => field.question)).toMatchObject([
      { id: "mode", isOther: true, isSecret: true },
      { id: "password", isSecret: false },
    ]);
    expect(decodeForm(result, { mode: [" Fast "], password: ["public"] })).toEqual({
      mode: "fast",
      password: "public",
    });
    expect(decodeForm(result, { mode: ["Custom"], password: ["public"] })).toEqual({
      mode__other: "Custom",
      password: "public",
    });
  });

  it("gates imagePicker as an explicit extension and projects ids without image data", () => {
    const properties = {
      template: {
        type: "openai/imagePicker",
        items: [
          { id: "monthly", title: "Monthly review", image: "data:image/png;base64,unused" },
          { id: "weekly", title: "Weekly plan", image: "https://invalid/unused" },
        ],
      },
    };
    expect(compile(properties).kind).toBe("unsupported");
    const enabled = compile(properties, ["template"], { ...baseOptions, allowImagePicker: true });
    expect(requireForm(enabled).fields[0]?.question.options).toEqual([
      { label: "Monthly review" },
      { label: "Weekly plan" },
    ]);
    expect(decodeForm(enabled, { template: ["Monthly review"] })).toEqual({ template: "monthly" });
  });

  it.each([
    [{ type: "integer", minimum: 3, maximum: 1 }, "numeric"],
    [{ type: "array", items: { type: "string", enum: ["x", "y"] }, maxItems: 3 }, "multi-select"],
  ])("declines unsupported or invalid constraints: %s", (field, message) => {
    const result = compile({ value: field }, ["value"]);
    expect(result).toMatchObject({
      kind: "unsupported",
      message: expect.stringContaining(message),
    });
  });

  it("snapshots own data without invoking accessors and enforces tree bounds", () => {
    const getter = vi.fn(() => "secret");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    expect(snapshotStructuredInput(accessor)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();

    let deep: unknown = "leaf";
    for (let index = 0; index < 10; index += 1) {
      deep = { next: deep };
    }
    expect(snapshotStructuredInput(deep)).toBeUndefined();
    expect(snapshotStructuredInput({ value: "x".repeat(65_537) })).toBeUndefined();
  });

  it("preserves an external URL separately from its completion question and rejects credentials", () => {
    const url = `https://example.com/authorize?state=${"a".repeat(1_500)}`;
    const result = urlInput(url);
    if (result.kind !== "ready" || result.plan.kind !== "url") {
      throw new Error("expected URL plan");
    }
    expect(result.plan.question).toMatchObject({
      url,
      question: expect.stringContaining(url),
      options: [{ label: "I've completed this step" }, { label: "Decline" }],
    });
    expect(urlInput("https://user:secret@example.com")).toMatchObject({
      kind: "unsupported",
      message: expect.stringContaining("credentials"),
    });
  });

  it("compiles an empty form only when allowEmptyForm is set", () => {
    expect(compile({}, [], { ...baseOptions, allowEmptyForm: false })).toMatchObject({
      kind: "unsupported",
      message: expect.stringContaining("empty"),
    });
    const withFlag = compile({});
    expect(requireForm(withFlag).fields).toEqual([]);
    expect(decodeForm(withFlag, {})).toEqual({});
  });
});

describe("OpenAI rich forms", () => {
  const suggestion = {
    const: "washer",
    title: "M6 washer",
    description: "Fits the joint",
    "x-openai-thumbnail": { src: "https://example.com/washer.png" },
  };

  it("keeps thumbnails and descriptions while decoding suggested and custom strings under the same constraints", () => {
    const result = richCompile(
      {
        part: string({ pattern: "^[a-z-]+$", minLength: 2, "x-openai-suggestions": [suggestion] }),
      },
      ["part"],
    );
    expect(requireForm(result).fields[0]?.question.options).toEqual([
      {
        label: "M6 washer",
        value: "washer",
        description: "Fits the joint",
        thumbnail: "https://example.com/washer.png",
      },
    ]);
    expect(decodeForm(result, { part: ["washer"] })).toEqual({ part: "washer" });
    expect(decodeForm(result, { part: ["custom-spacer"] })).toEqual({ part: "custom-spacer" });
    expect(decodeForm(result, { part: ["123"] })).toContain("pattern");
    expect(richCompile({ part: string({ pattern: "(a+)+$" }) }).kind).toBe("unsupported");
  });

  it("decodes multiple custom array entries with item, cardinality, and uniqueness validation", () => {
    const result = richCompile(
      {
        parts: strings(
          { minItems: 1, maxItems: 3, uniqueItems: true },
          string({ maxLength: 20, "x-openai-suggestions": [suggestion] }),
        ),
      },
      ["parts"],
    );
    expect(decodeForm(result, { parts: ["washer", "custom-spacer", "custom-gasket"] })).toEqual({
      parts: ["washer", "custom-spacer", "custom-gasket"],
    });
    expect(decodeForm(result, { parts: ["washer", "washer"] })).toContain("unique");
    expect(decodeForm(result, { parts: ["x".repeat(21)] })).toContain("at most");
    expect(decodeForm(result, { parts: ["a", "b", "c", "d"] })).toContain("between");
  });

  it("maps supplied single and multi-resource choices to their exact URIs and presents defaults without reinserting cleared answers", () => {
    const resource = {
      uri: "cad://parts/washer",
      name: "washer",
      title: "M6 washer",
      _meta: { "openai/thumbnail": { src: "https://example.com/washer.png" } },
    };
    const input = { type: "resource", options: [resource] };
    const result = richCompile({
      single: resourceField(input, { default: resource.uri }),
      multiple: resourceFields(
        { ...input, type: "file", selection: "explicit" },
        { default: [resource.uri] },
      ),
    });
    expect(decodeForm(result, { single: [resource.uri], multiple: [resource.uri] })).toEqual({
      single: resource.uri,
      multiple: [resource.uri],
    });
    expect(decodeForm(result, { single: [], multiple: [] })).toEqual({});
    expect(requireForm(result).fields[0]?.question).toMatchObject({
      defaultAnswers: [resource.uri],
      allowEmpty: true,
    });
    expect(decodeForm(result, { single: ["file:///ungranted"], multiple: [] })).toContain(
      "not admitted",
    );
  });

  it("binds previews and implicit uploads to the exact resource capability, never arbitrary entered URIs", () => {
    const source = {
      viewId: "mcp-app-form",
      uploads: true,
      previews: true,
      isUploadedResource: (questionId: string, uri: string) =>
        questionId === "parts" && uri === "file:///admitted/part.stl",
    };
    const resource = previewResource({
      type: "mcp_app_tool",
      name: "cad.open",
      arguments: { resourceUri: "cad://parts/washer" },
    });
    const result = compile(
      { parts: resourceFields({ type: "resource", selection: "implicit", options: [resource] }) },
      [],
      { ...rich, resourceContext: source },
    );
    expect(requireForm(result).fields[0]?.question).toMatchObject({
      defaultAnswers: [resource.uri],
      resource: { viewId: "mcp-app-form", selection: "implicit", userOptions: { kind: "file" } },
      options: [{ resourceUri: resource.uri, preview: { type: "mcp_app_tool", name: "cad.open" } }],
    });
    expect(decodeForm(result, { parts: [resource.uri, "file:///admitted/part.stl"] })).toEqual({
      parts: [resource.uri, "file:///admitted/part.stl"],
    });
    expect(decodeForm(result, { parts: [] })).toEqual({ parts: [] });
    expect(decodeForm(result, { parts: ["file:///ungranted/part.stl"] })).toContain("not admitted");
    source.uploads = false;
    expect(
      compile({ file: resourceField({ type: "resource", options: [], userOptions: {} }) }, [], {
        ...rich,
        resourceContext: source,
      }).kind,
    ).toBe("unsupported");
  });

  it("preserves all rich choices without increasing the ordinary form bound", () => {
    const values = Array.from({ length: 12 }, (_, index) => ({
      const: "value-" + index,
      title: "Choice " + index,
    }));
    const fields = { selected: string({ oneOf: values }) };
    expect(compile(fields).kind).toBe("unsupported");
    const result = richCompile(fields, ["selected"]);
    expect(decodeForm(result, { selected: ["value-11"] })).toEqual({ selected: "value-11" });
    expect(requireForm(result).fields[0]?.question.options).toHaveLength(12);
  });

  it.each([
    { type: "unknown", options: [] },
    {
      type: "resource",
      options: [
        previewResource({ type: "resource_link", uri: "cad://parts/washer", name: "Washer" }),
      ],
    },
  ])("refuses the whole form when a resource operation cannot be honored: %j", (input) => {
    expect(richCompile({ ordinary: string(), resource: resourceFields(input) }).kind).toBe(
      "unsupported",
    );
  });

  it.each([
    "javascript:alert(1)",
    "http://example.com/image.png",
    "https://user:pass@example.com/image.png",
  ])("refuses unsafe thumbnail %s without partially displaying the form", (src) => {
    expect(
      richCompile({
        ordinary: string(),
        choice: string({ oneOf: [{ const: "a", title: "A", "x-openai-thumbnail": { src } }] }),
      }).kind,
    ).toBe("unsupported");
  });
});
