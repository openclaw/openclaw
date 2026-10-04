import { readQuestionResourcePreview } from "../../../packages/gateway-protocol/src/question-media.js";
import {
  isStructuredInputRecord,
  structuredInputArray as ownArray,
  structuredInputInteger as ownInteger,
  structuredInputRecord as ownRecord,
  structuredInputString as ownString,
  structuredInputValue as ownValue,
} from "./structured-input-boundary.js";
import type {
  StructuredInputCompilerOptions,
  StructuredInputField,
  StructuredInputRecord,
} from "./structured-input-boundary.js";
import {
  buildField,
  compileStringField,
  findChoice,
  invalid,
  normalizeChoices,
  readSuggestions,
  validateChoices,
  type Choice,
  type DecodeValue,
  type FieldContext,
} from "./structured-input-field.js";

export function compileStringArrayField(
  context: FieldContext,
  schema: StructuredInputRecord,
  items: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): StructuredInputField | string {
  const minItems = ownInteger(schema, "minItems", 0);
  const maximum = ownInteger(schema, "maxItems", 0);
  const maxItems = maximum === undefined ? 16 : maximum;
  const unique = ownValue(schema, "uniqueItems");
  if (
    minItems === null ||
    maxItems === null ||
    maxItems > 16 ||
    (minItems ?? 0) > maxItems ||
    (unique !== undefined && typeof unique !== "boolean")
  ) {
    return "has invalid array constraints.";
  }
  const item = compileStringField({ ...context, required: true }, items, options);
  if (typeof item === "string") {
    return item;
  }
  const suggestions = readSuggestions(items, options);
  if (typeof suggestions === "string") {
    return suggestions;
  }
  const decode = (values: readonly string[]): DecodeValue => {
    if (values.length < (minItems ?? 0) || values.length > maxItems) {
      return invalid(context, `requires between ${minItems ?? 0} and ${maxItems} entries.`);
    }
    const decoded: string[] = [];
    for (const value of values) {
      const result = item.decode([value]);
      if (result.kind === "invalid") {
        return result;
      }
      const answer = result.kind === "present" ? result.entries[0]?.[1] : undefined;
      if (typeof answer !== "string") {
        return invalid(context, "contains an invalid string entry.");
      }
      decoded.push(answer);
    }
    if (unique === true && new Set(decoded).size !== decoded.length) {
      return invalid(context, "requires unique entries.");
    }
    return { kind: "present", value: decoded };
  };
  const rawDefault = ownValue(schema, "default");
  const defaultValue =
    Array.isArray(rawDefault) &&
    rawDefault.every((value): value is string => typeof value === "string")
      ? rawDefault
      : undefined;
  if (rawDefault !== undefined && (!defaultValue || decode(defaultValue).kind !== "present")) {
    return "has an invalid string array default.";
  }
  return buildField(context, schema, {
    constraints: [
      "Enter each custom value on a separate line.",
      item.question.question,
      `between ${minItems ?? 0} and ${maxItems} entries`,
    ],
    options: suggestions ?? null,
    isOther: true,
    multiSelect: true,
    answerFormat: "lines",
    allowEmpty: (minItems ?? 0) === 0,
    defaultValue,
    decode,
  });
}

export function compileResourceField(
  context: FieldContext,
  schema: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): StructuredInputField | string {
  const input = ownRecord(schema, "x-openai-input");
  const type = ownString(schema, "type");
  if (
    !input ||
    !["resource", "file"].includes(ownString(input, "type") ?? "") ||
    (type !== "string" && type !== "array")
  ) {
    return "uses an unsupported resource input.";
  }
  const selection = ownValue(input, "selection") ?? "explicit";
  if (
    (type === "string" && ownValue(input, "selection") !== undefined) ||
    (selection !== "explicit" && selection !== "implicit")
  ) {
    return "has an invalid resource selection mode.";
  }
  const source = options.resourceContext;
  const rawUserOptions = ownValue(input, "userOptions");
  const userOptions =
    rawUserOptions === undefined && selection === "implicit" ? {} : rawUserOptions;
  let upload: { kind: "file" | "directory"; accept?: string[] } | undefined;
  if (userOptions !== undefined) {
    if (!isStructuredInputRecord(userOptions)) {
      return "has invalid user resource options.";
    }
    const kind = ownValue(userOptions, "kind") ?? "file";
    const accept = ownValue(userOptions, "accept");
    if (
      (kind !== "file" && kind !== "directory") ||
      (accept !== undefined &&
        (!Array.isArray(accept) ||
          accept.length > 32 ||
          !accept.every(
            (entry) =>
              typeof entry === "string" &&
              entry.length <= 128 &&
              /^(?:\.[a-z0-9.+_-]+|[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*))$/iu.test(entry),
          )))
    ) {
      return "has invalid resource upload restrictions.";
    }
    if (!source?.uploads) {
      return "requires resource uploads unavailable on this input surface.";
    }
    upload = {
      kind,
      ...(Array.isArray(accept)
        ? { accept: accept.filter((entry): entry is string => typeof entry === "string") }
        : {}),
    };
  }
  const resources = ownArray(input, "options", 64);
  const itemSchema = type === "array" ? ownRecord(schema, "items") : schema;
  if (
    !resources ||
    !itemSchema ||
    ownString(itemSchema, "format") !== "uri" ||
    ownString(itemSchema, "type") !== "string"
  ) {
    return "has an invalid resource schema.";
  }
  const { "x-openai-input": _input, default: _default, ...stringSchema } = itemSchema;
  const validator = compileStringField({ ...context, required: true }, stringSchema, options);
  if (typeof validator === "string") {
    return validator;
  }
  const choices: Choice[] = [];
  for (const resource of resources) {
    if (!isStructuredInputRecord(resource)) {
      return "contains an invalid resource.";
    }
    const uri = ownString(resource, "uri");
    const name = ownString(resource, "name");
    if (!uri || uri.length > 2048 || !name || validator.decode([uri]).kind !== "present") {
      return "contains a resource outside its URI constraints.";
    }
    const meta = ownRecord(resource, "_meta");
    const previewMetadata = meta ? ownValue(meta, "openai/preview") : undefined;
    const preview = isStructuredInputRecord(previewMetadata)
      ? readQuestionResourcePreview(ownValue(previewMetadata, "target"))
      : undefined;
    if (previewMetadata !== undefined && (!preview || !source?.previews)) {
      return "requires a resource preview unavailable on this input surface.";
    }
    const normalized = normalizeChoices(
      [
        {
          value: uri,
          label: ownString(resource, "title") ?? name,
          description: ownValue(resource, "description"),
          thumbnail: meta ? ownValue(meta, "openai/thumbnail") : undefined,
        },
      ],
      1,
      64,
      2048,
    );
    if (typeof normalized === "string") {
      return normalized;
    }
    choices.push({ ...normalized[0]!, resourceUri: uri, ...(preview ? { preview } : {}) });
  }
  const choiceError = validateChoices(choices);
  if (choiceError) {
    return choiceError;
  }
  const minimum = type === "array" ? ownInteger(schema, "minItems", 0) : undefined;
  const maximum = type === "array" ? ownInteger(schema, "maxItems", 0) : 1;
  if (
    minimum === null ||
    maximum === null ||
    (minimum ?? 0) > (maximum ?? 64) ||
    (maximum ?? 64) > 64
  ) {
    return "has invalid resource selection limits.";
  }
  if (
    choices.length === 0 &&
    !upload &&
    context.required &&
    (type === "string" || (minimum ?? 0) > 0)
  ) {
    return "has no selectable or uploadable resources for a required selection.";
  }
  const rawDefault = ownValue(schema, "default");
  if (selection === "implicit" && rawDefault !== undefined) {
    return "declares a default for implicit selection.";
  }
  const defaults =
    typeof rawDefault === "string" && type === "string"
      ? [rawDefault]
      : type === "array" &&
          Array.isArray(rawDefault) &&
          rawDefault.every((value): value is string => typeof value === "string")
        ? rawDefault
        : undefined;
  if (
    rawDefault !== undefined &&
    (!defaults ||
      defaults.some((value) => !choices.some((choice) => choice.value === value)) ||
      new Set(defaults).size !== defaults.length ||
      defaults.length < (minimum ?? 0) ||
      defaults.length > (maximum ?? 64))
  ) {
    return "has an invalid resource default.";
  }
  const defaultValue =
    selection === "implicit"
      ? choices.map((choice) => choice.value)
      : type === "string"
        ? defaults?.[0]
        : defaults;
  return buildField(context, schema, {
    constraints: [
      selection === "implicit"
        ? "Remove resources to exclude them; all remaining resources will be submitted."
        : undefined,
    ],
    options: choices,
    isOther: Boolean(upload),
    multiSelect: type === "array",
    allowEmpty: type === "array" && (minimum ?? 0) === 0,
    defaultValue,
    resource: {
      ...(source ? { viewId: source.viewId } : {}),
      selection,
      ...(upload ? { userOptions: upload } : {}),
    },
    decode: (values) => {
      if (values.length < (minimum ?? 0) || values.length > (maximum ?? 64)) {
        return invalid(context, "has an invalid number of resources.");
      }
      for (const value of values) {
        const supplied = findChoice(choices, value, true);
        if (
          (!supplied && (!upload || !source?.isUploadedResource(context.questionId, value))) ||
          validator.decode([value]).kind !== "present"
        ) {
          return invalid(context, "contains a resource not admitted for this field.");
        }
      }
      if (new Set(values).size !== values.length) {
        return invalid(context, "contains duplicate resources.");
      }
      return { kind: "present", value: type === "array" ? [...values] : (values[0] ?? "") };
    },
  });
}
