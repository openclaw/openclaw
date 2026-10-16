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
  validateChoices,
  type Choice,
  type FieldContext,
} from "./structured-input-field.js";
import { compileResourceField, compileStringArrayField } from "./structured-input-rich.js";

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
    return options.allowImagePicker === true
      ? compileImagePickerField(context, schema)
      : `uses unsupported type ${quote(type)}.`;
  }
  if (type === "boolean") {
    return compileBooleanField(context, schema, options);
  }
  if (type === "number" || type === "integer") {
    return compileNumberField(context, schema, type);
  }
  if (type === "array") {
    return compileMultiSelectField(context, schema, options);
  }
  if (type !== "string") {
    return `uses unsupported type ${quote(type)}.`;
  }
  const choices = readChoices(schema, options);
  if (typeof choices === "string") {
    return choices;
  }
  return choices
    ? compileChoiceField(context, schema, choices)
    : compileStringField(context, schema, options);
}

function compileNumberField(
  context: FieldContext,
  schema: StructuredInputRecord,
  type: "number" | "integer",
): StructuredInputField | string {
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

function compileBooleanField(
  context: FieldContext,
  schema: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): StructuredInputField | string {
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

function compileMultiSelectField(
  context: FieldContext,
  schema: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): StructuredInputField | string {
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
    return compileStringArrayField(context, schema, items, options);
  }
  const choices = readArrayChoices(items, options);
  if (typeof choices === "string") {
    return choices;
  }
  const minItems = ownInteger(schema, "minItems", 0);
  const maxItems = ownInteger(schema, "maxItems", 0);
  if (
    minItems === null ||
    maxItems === null ||
    (minItems !== undefined && maxItems !== undefined && minItems > maxItems) ||
    (minItems !== undefined && minItems > choices.length) ||
    (!options.allowRichForms && maxItems !== undefined && maxItems > choices.length)
  ) {
    return "has invalid multi-select limits.";
  }
  const rawDefault = ownValue(schema, "default");
  const defaultEntries =
    rawDefault === null ? undefined : ownArray(schema, "default", choices.length);
  const defaultValue = defaultEntries?.filter(
    (value): value is string => typeof value === "string",
  );
  if (
    rawDefault !== undefined &&
    rawDefault !== null &&
    (!defaultEntries ||
      defaultValue?.length !== defaultEntries.length ||
      defaultValue.some((value) => !choices.some((choice) => choice.value === value)) ||
      new Set(defaultValue).size !== defaultValue.length ||
      (minItems !== undefined && defaultValue.length < minItems) ||
      (maxItems !== undefined && defaultValue.length > maxItems))
  ) {
    return "has an invalid multi-select default.";
  }
  return buildField(context, schema, {
    constraints: [
      minItems !== undefined ? `choose at least ${minItems}` : undefined,
      maxItems !== undefined ? `choose at most ${maxItems}` : undefined,
    ],
    options: choices,
    isOther: false,
    multiSelect: true,
    allowEmpty: options.allowRichForms === true && (minItems ?? 0) === 0,
    defaultValue,
    decode: (values) => {
      const decoded = values.flatMap((value) => {
        const choice = findChoice(choices, value, context.explicitDefaults);
        return choice ? [choice.value] : [];
      });
      if (decoded.length !== values.length || new Set(decoded).size !== decoded.length) {
        return invalid(context, "contains an invalid or duplicate choice.");
      }
      if (minItems !== undefined && decoded.length < minItems) {
        return invalid(context, `requires at least ${minItems} choices.`);
      }
      if (maxItems !== undefined && decoded.length > maxItems) {
        return invalid(context, `allows at most ${maxItems} choices.`);
      }
      return { kind: "present", value: decoded };
    },
  });
}

function compileImagePickerField(
  context: FieldContext,
  schema: StructuredInputRecord,
): StructuredInputField | string {
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
