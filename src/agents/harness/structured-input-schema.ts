import { isStringArray } from "@openclaw/normalization-core/record-coerce";
import { readQuestionResourcePreview } from "../../../packages/gateway-protocol/src/question-media.js";
import {
  hasUnsafeVisibleCharacters,
  isStructuredInputRecord,
  quoteStructuredInputValue as quote,
  structuredInputArray as ownArray,
  structuredInputEntries,
  structuredInputFiniteNumber as ownFiniteNumber,
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
  MAX_CHOICE_COUNT,
  MAX_CHOICE_LABEL,
  normalizeChoices,
  readStructuredInputChoice,
  readSuggestions,
  validateChoices,
  type Choice,
  type DecodeValue,
  type FieldContext,
} from "./structured-input-field.js";

const MAX_SCHEMA_KEYS = 24;
const MAX_IMAGE_PICKER_ID = 128;

export function compileStructuredInputField(
  fieldContext: FieldContext,
  schema: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): StructuredInputField | string {
  const context = { ...fieldContext, explicitDefaults: options.allowRichForms === true };
  if (!structuredInputEntries(schema, MAX_SCHEMA_KEYS)) {
    return "has an over-limit schema.";
  }
  if (options.allowRichForms) {
    const supported = new Set([
      "type",
      "title",
      "description",
      "default",
      "minLength",
      "maxLength",
      "pattern",
      "format",
      "minimum",
      "maximum",
      "minItems",
      "maxItems",
      "uniqueItems",
      "items",
      "enum",
      "enumNames",
      "oneOf",
      "isSecret",
      "_meta",
      "x-openai-input",
      "x-openai-suggestions",
    ]);
    if (Object.keys(schema).some((key) => !supported.has(key))) {
      return "uses unsupported field constraints.";
    }
    if (
      ownValue(schema, "x-openai-suggestions") !== undefined &&
      (ownValue(schema, "enum") !== undefined || ownValue(schema, "oneOf") !== undefined)
    ) {
      return "combines suggestions with a closed choice list.";
    }
  }
  const type = ownString(schema, "type");
  if (ownValue(schema, "x-openai-input") !== undefined) {
    return options.allowRichForms
      ? compileResourceField(context, schema, options)
      : "uses an unsupported semantic input.";
  }
  if (type === "openai/imagePicker") {
    if (options.allowImagePicker !== true) {
      return `uses unsupported type ${quote(type)}.`;
    }
    const items = ownArray(schema, "items", MAX_CHOICE_COUNT);
    if (!items || items.length === 0) {
      return `must contain 1 to ${MAX_CHOICE_COUNT} image choices.`;
    }
    const choices: Choice[] = [];
    for (const item of items) {
      if (!isStructuredInputRecord(item)) {
        return "has an invalid image choice.";
      }
      const id = ownString(item, "id");
      const title = ownString(item, "title");
      if (
        !id ||
        !title ||
        id.length > MAX_IMAGE_PICKER_ID ||
        title.length > MAX_CHOICE_LABEL ||
        hasUnsafeVisibleCharacters(id) ||
        hasUnsafeVisibleCharacters(title)
      ) {
        return "has an image choice with an invalid or over-limit id/title.";
      }
      choices.push({ value: id, label: title });
    }
    const error = validateChoices(choices);
    return error ?? compileChoiceField(context, schema, choices);
  }
  if (type === "boolean") {
    const rawDefault = ownValue(schema, "default");
    const defaultValue = typeof rawDefault === "boolean" ? rawDefault : undefined;
    if (rawDefault !== undefined && rawDefault !== null && defaultValue === undefined) {
      return "has a non-boolean default.";
    }
    const [positive, negative] = options.booleanLabels ?? ["Yes", "No"];
    const choices = [
      { label: positive, value: "true" },
      { label: negative, value: "false" },
    ];
    return buildField(context, schema, {
      constraints: [],
      options: choices,
      isOther: false,
      defaultValue,
      decode: (values) => {
        const selected = findChoice(choices, values[0], context.explicitDefaults);
        return selected
          ? { kind: "present", value: selected.value === "true" }
          : invalid(context, `must be ${positive} or ${negative}.`);
      },
    });
  }
  if (type === "number" || type === "integer") {
    const minimum = ownFiniteNumber(schema, "minimum");
    const maximum = ownFiniteNumber(schema, "maximum");
    if (
      minimum === null ||
      maximum === null ||
      (minimum !== undefined && maximum !== undefined && minimum > maximum)
    ) {
      return "has invalid numeric constraints.";
    }
    const rawDefault = ownValue(schema, "default");
    const defaultValue = typeof rawDefault === "number" ? rawDefault : undefined;
    if (rawDefault !== undefined && rawDefault !== null && defaultValue === undefined) {
      return "has a non-numeric default.";
    }
    const validate = (value: number): string | undefined => {
      if (!Number.isFinite(value)) {
        return "must be a finite number.";
      }
      if (type === "integer" && !Number.isInteger(value)) {
        return "must be an integer.";
      }
      if (minimum !== undefined && value < minimum) {
        return `must be at least ${minimum}.`;
      }
      if (maximum !== undefined && value > maximum) {
        return `must be at most ${maximum}.`;
      }
      return undefined;
    };
    if (defaultValue !== undefined && validate(defaultValue)) {
      return "has a default outside its numeric constraints.";
    }
    return buildField(context, schema, {
      constraints: [
        type === "integer" ? "whole number" : "number",
        minimum !== undefined ? `minimum ${minimum}` : undefined,
        maximum !== undefined ? `maximum ${maximum}` : undefined,
      ],
      options: null,
      isOther: true,
      defaultValue,
      decode: (values) => {
        const raw = values[0]?.trim() ?? "";
        if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(raw)) {
          return invalid(context, type === "integer" ? "must be an integer." : "must be a number.");
        }
        const value = Number(raw);
        const error = validate(value);
        return error ? invalid(context, error) : { kind: "present", value };
      },
    });
  }
  if (type === "array") {
    const items = ownRecord(schema, "items");
    if (!items) {
      return "has no string choice schema for its array items.";
    }
    if (
      options.allowRichForms &&
      ownString(items, "type") === "string" &&
      ownValue(items, "enum") === undefined &&
      ownValue(items, "oneOf") === undefined &&
      ownValue(items, "anyOf") === undefined
    ) {
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
      const defaultValue = isStringArray(rawDefault) ? rawDefault : undefined;
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
    const choices = readArrayChoices(items, options);
    if (typeof choices === "string") {
      return choices;
    }
    const minChoices = ownInteger(schema, "minItems", 0);
    const maxChoices = ownInteger(schema, "maxItems", 0);
    if (
      minChoices === null ||
      maxChoices === null ||
      (minChoices !== undefined && maxChoices !== undefined && minChoices > maxChoices) ||
      (minChoices !== undefined && minChoices > choices.length) ||
      (!options.allowRichForms && maxChoices !== undefined && maxChoices > choices.length)
    ) {
      return "has invalid multi-select limits.";
    }
    const rawChoiceDefault = ownValue(schema, "default");
    const defaultEntries =
      rawChoiceDefault === null ? undefined : ownArray(schema, "default", choices.length);
    const defaultChoices = defaultEntries?.filter(
      (value): value is string => typeof value === "string",
    );
    if (
      rawChoiceDefault !== undefined &&
      rawChoiceDefault !== null &&
      (!defaultEntries ||
        defaultChoices?.length !== defaultEntries.length ||
        defaultChoices.some((value) => !choices.some((choice) => choice.value === value)) ||
        new Set(defaultChoices).size !== defaultChoices.length ||
        (minChoices !== undefined && defaultChoices.length < minChoices) ||
        (maxChoices !== undefined && defaultChoices.length > maxChoices))
    ) {
      return "has an invalid multi-select default.";
    }
    return buildField(context, schema, {
      constraints: [
        minChoices !== undefined ? `choose at least ${minChoices}` : undefined,
        maxChoices !== undefined ? `choose at most ${maxChoices}` : undefined,
      ],
      options: choices,
      isOther: false,
      multiSelect: true,
      allowEmpty: options.allowRichForms === true && (minChoices ?? 0) === 0,
      defaultValue: defaultChoices,
      decode: (values) => {
        const decoded = values.flatMap((value) => {
          const choice = findChoice(choices, value, context.explicitDefaults);
          return choice ? [choice.value] : [];
        });
        if (decoded.length !== values.length || new Set(decoded).size !== decoded.length) {
          return invalid(context, "contains an invalid or duplicate choice.");
        }
        if (minChoices !== undefined && decoded.length < minChoices) {
          return invalid(context, `requires at least ${minChoices} choices.`);
        }
        if (maxChoices !== undefined && decoded.length > maxChoices) {
          return invalid(context, `allows at most ${maxChoices} choices.`);
        }
        return { kind: "present", value: decoded };
      },
    });
  }
  if (type !== "string") {
    return `uses unsupported type ${quote(type)}.`;
  }
  const stringChoices = readChoices(schema, options);
  if (typeof stringChoices === "string") {
    return stringChoices;
  }
  return stringChoices
    ? compileChoiceField(context, schema, stringChoices)
    : compileStringField(context, schema, options);
}

function compileChoiceField(
  context: FieldContext,
  schema: StructuredInputRecord,
  choices: Choice[],
): StructuredInputField | string {
  const rawDefault = ownValue(schema, "default");
  const defaultValue = typeof rawDefault === "string" ? rawDefault : undefined;
  if (
    rawDefault !== undefined &&
    rawDefault !== null &&
    (defaultValue === undefined || !choices.some((choice) => choice.value === defaultValue))
  ) {
    return "has a default outside its declared choices.";
  }
  return buildField(context, schema, {
    constraints: [],
    options: choices,
    isOther: context.otherFieldId !== undefined,
    defaultValue,
    decode: (values) => {
      const selected = findChoice(choices, values[0], context.explicitDefaults);
      if (selected) {
        return { kind: "present", value: selected.value };
      }
      return context.otherFieldId
        ? { kind: "present", value: values[0] ?? "" }
        : invalid(context, "contains an undeclared choice.");
    },
  });
}

function readChoices(
  schema: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): Choice[] | string | undefined {
  const enumValue = ownValue(schema, "enum");
  const oneOfValue = ownValue(schema, "oneOf");
  if (
    enumValue !== undefined &&
    enumValue !== null &&
    oneOfValue !== undefined &&
    oneOfValue !== null
  ) {
    return "declares both enum and oneOf choices.";
  }
  let choices: Parameters<typeof normalizeChoices>[0];
  if (enumValue !== undefined && enumValue !== null) {
    if (!Array.isArray(enumValue)) {
      return "has an invalid enum.";
    }
    const enumNames = options.allowEnumNames ? ownValue(schema, "enumNames") : undefined;
    if (
      enumNames !== undefined &&
      (!Array.isArray(enumNames) || enumNames.length !== enumValue.length)
    ) {
      return "has invalid enumNames.";
    }
    choices = enumValue.map((value, index) => ({
      value,
      label: Array.isArray(enumNames) ? enumNames[index] : value,
    }));
  } else if (oneOfValue !== undefined && oneOfValue !== null) {
    if (!Array.isArray(oneOfValue)) {
      return "has an invalid oneOf.";
    }
    choices = oneOfValue.map((entry) => readStructuredInputChoice(entry, options));
  } else {
    return undefined;
  }
  return normalizeChoices(
    choices,
    options.minimumChoiceCount ?? 1,
    options.allowRichForms ? 64 : MAX_CHOICE_COUNT,
  );
}

function readArrayChoices(
  items: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): Choice[] | string {
  if (ownString(items, "type") === "string") {
    return readChoices(items, options) ?? "must declare enum or oneOf array choices.";
  }
  const entries = ownValue(items, "anyOf") ?? ownValue(items, "oneOf");
  if (!Array.isArray(entries)) {
    return "must declare string enum, anyOf, or oneOf array choices.";
  }
  return normalizeChoices(
    entries.map((entry) => readStructuredInputChoice(entry, options)),
    options.minimumChoiceCount ?? 1,
    options.allowRichForms ? 64 : MAX_CHOICE_COUNT,
  );
}

function compileResourceField(
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
            (entry): entry is string =>
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
      ...(accept ? { accept: [...accept] } : {}),
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
      : type === "array" && isStringArray(rawDefault)
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
