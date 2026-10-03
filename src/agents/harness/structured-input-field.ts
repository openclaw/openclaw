import { isQuestionThumbnail } from "../../../packages/gateway-protocol/src/question-media.js";
import { compileSafeRegex } from "../../security/safe-regex.js";
import {
  boundStructuredInputText as boundText,
  hasUnsafeVisibleCharacters,
  isStructuredInputRecord,
  quoteStructuredInputValue as quote,
  readStructuredInputText,
  structuredInputInteger as ownInteger,
  structuredInputString as ownString,
  structuredInputValue as ownValue,
} from "./structured-input-boundary.js";
import type {
  StructuredInputAnswerValue,
  StructuredInputCompilerOptions,
  StructuredInputField,
  StructuredInputRecord,
  StructuredInputValue,
} from "./structured-input-boundary.js";
import type {
  AgentHarnessUserInputOption,
  AgentHarnessUserInputQuestion,
} from "./user-input-types.js";

export const MAX_CHOICE_COUNT = 4;
export const MAX_CHOICE_LABEL = 64;
const MAX_CHOICE_VALUE = 256;
const MAX_FIELD_TEXT = 512;
const MAX_INPUT_TEXT = 4096;
export type FieldContext = {
  fieldId: string;
  questionId: string;
  required: boolean;
  secret: boolean;
  otherFieldId?: string;
  explicitDefaults?: boolean;
};
export type Choice = AgentHarnessUserInputOption & { value: string };
export type DecodeValue =
  | { kind: "absent" }
  | { kind: "invalid"; message: string }
  | { kind: "present"; value: StructuredInputAnswerValue };

export function compileStringField(
  context: FieldContext,
  schema: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): StructuredInputField | string {
  const minLength = ownInteger(schema, "minLength", 0);
  const maxLength = ownInteger(schema, "maxLength", 0);
  if (
    minLength === null ||
    maxLength === null ||
    (minLength !== undefined && minLength > MAX_INPUT_TEXT) ||
    (maxLength !== undefined && maxLength > MAX_INPUT_TEXT) ||
    (minLength !== undefined && maxLength !== undefined && minLength > maxLength)
  ) {
    return "has invalid string length constraints.";
  }
  const pattern = ownValue(schema, "pattern");
  const regex =
    typeof pattern === "string" && pattern.length <= MAX_FIELD_TEXT && options.allowRichForms
      ? pattern === ""
        ? /(?:)/u
        : compileSafeRegex(pattern, "u")
      : undefined;
  if (pattern !== undefined && pattern !== null && !regex) {
    return "uses an unsupported or unsafe pattern constraint.";
  }
  // The configuration regex guard trims input; schema patterns retain significant whitespace.
  const exactRegex = regex && typeof pattern === "string" ? new RegExp(pattern, "u") : undefined;
  const suggestions = readSuggestions(schema, options);
  if (typeof suggestions === "string") {
    return suggestions;
  }
  const format = ownString(schema, "format");
  if (format && !["email", "uri", "date", "date-time"].includes(format)) {
    return `uses unsupported string format ${quote(format)}.`;
  }
  const defaultValue = ownValue(schema, "default");
  if (defaultValue !== undefined && defaultValue !== null && typeof defaultValue !== "string") {
    return "has a non-string default.";
  }
  const defaultText = typeof defaultValue === "string" ? defaultValue : undefined;
  const validate = (value: string): string | undefined => {
    if (value.length > MAX_INPUT_TEXT) {
      return `must contain at most ${MAX_INPUT_TEXT} characters.`;
    }
    const length = options.allowRichForms ? Array.from(value).length : value.length;
    if (minLength !== undefined && length < minLength) {
      return `must contain at least ${minLength} characters.`;
    }
    if (maxLength !== undefined && length > maxLength) {
      return `must contain at most ${maxLength} characters.`;
    }
    if (exactRegex && !exactRegex.test(value)) {
      return "does not match its required pattern.";
    }
    if (format && !matchesStringFormat(value, format)) {
      return `is not a valid ${format} value.`;
    }
    return undefined;
  };
  if (defaultText !== undefined) {
    const error = validate(defaultText);
    if (error) {
      return `has a default that ${error}`;
    }
  }
  if (suggestions?.some((choice) => validate(choice.value))) {
    return "has suggestions outside its string constraints.";
  }
  return buildField(context, schema, {
    constraints: [
      minLength !== undefined ? `minimum ${minLength} characters` : undefined,
      `maximum ${maxLength ?? MAX_INPUT_TEXT} characters`,
      format ? `format: ${format}` : undefined,
      typeof pattern === "string" ? `pattern: ${pattern}` : undefined,
    ],
    options: suggestions ?? null,
    isOther: true,
    allowEmpty: options.allowRichForms === true && (minLength ?? 0) === 0,
    defaultValue: defaultText,
    decode: (values) => {
      const raw = values[0] ?? "";
      const value = suggestions
        ? (findChoice(suggestions, raw, context.explicitDefaults)?.value ?? raw)
        : raw;
      const error = validate(value);
      return error ? invalid(context, error) : { kind: "present", value };
    },
  });
}

export function readSuggestions(
  schema: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): Choice[] | string | undefined {
  const raw = ownValue(schema, "x-openai-suggestions");
  if (raw === undefined) {
    return undefined;
  }
  if (!options.allowRichForms || !Array.isArray(raw)) {
    return "uses unsupported or invalid suggestions.";
  }
  if (raw.length === 0) {
    return [];
  }
  return normalizeChoices(
    raw.map((entry) => readStructuredInputChoice(entry, options)),
    1,
    64,
  );
}

export function readStructuredInputChoice(
  entry: StructuredInputValue,
  options: StructuredInputCompilerOptions,
) {
  if (!isStructuredInputRecord(entry)) {
    return { value: undefined, label: undefined };
  }
  return {
    value: ownValue(entry, "const"),
    label: ownValue(entry, "title"),
    description: ownValue(entry, "description"),
    thumbnail: options.allowRichForms ? ownValue(entry, "x-openai-thumbnail") : undefined,
  };
}

export function buildField(
  context: FieldContext,
  schema: StructuredInputRecord,
  params: {
    constraints: Array<string | undefined>;
    options: Choice[] | null;
    isOther: boolean;
    multiSelect?: boolean;
    answerFormat?: "lines";
    resource?: AgentHarnessUserInputQuestion["resource"];
    allowEmpty?: boolean;
    defaultValue?: StructuredInputAnswerValue;
    decode: (values: readonly string[]) => DecodeValue;
  },
): StructuredInputField {
  const title =
    readStructuredInputText(ownString(schema, "title") ?? context.fieldId, MAX_FIELD_TEXT) ??
    "Field";
  const description =
    readStructuredInputText(ownString(schema, "description") ?? "", MAX_FIELD_TEXT) ?? "";
  const details = [
    description,
    context.required ? "Required." : "Optional.",
    params.defaultValue !== undefined ? `Default: ${displayDefault(params.defaultValue)}.` : "",
    params.constraints.filter(Boolean).join("; "),
  ].filter(Boolean);
  return {
    question: {
      id: context.questionId,
      presentation: "form",
      ...(params.resource ? { resource: params.resource } : {}),
      header: boundText(title, 12),
      question: boundText(`${title}\n${details.join(" ")}`, MAX_FIELD_TEXT),
      ...(!context.required || params.allowEmpty ? { allowEmpty: true } : {}),
      ...(params.multiSelect ? { multiSelect: true } : {}),
      ...(params.answerFormat ? { answerFormat: params.answerFormat } : {}),
      ...(params.defaultValue !== undefined && !context.secret
        ? {
            defaultAnswers: (Array.isArray(params.defaultValue)
              ? params.defaultValue
              : [String(params.defaultValue)]
            ).map((value) =>
              context.explicitDefaults
                ? value
                : (params.options?.find((choice) => choice.value === value)?.label ?? value),
            ),
          }
        : {}),
      isOther: params.isOther,
      isSecret: context.secret,
      options:
        params.options?.map((choice): AgentHarnessUserInputOption => ({
          label: choice.label,
          ...(context.explicitDefaults ? { value: choice.value } : {}),
          ...(choice.description ? { description: choice.description } : {}),
          ...(choice.thumbnail ? { thumbnail: choice.thumbnail } : {}),
          ...(choice.resourceUri ? { resourceUri: choice.resourceUri } : {}),
          ...(choice.preview ? { preview: choice.preview } : {}),
        })) ?? null,
    },
    decode: (values) => {
      const decoded =
        (((params.allowEmpty && context.required) || params.resource?.selection === "implicit") &&
        values.length === 0
          ? undefined
          : decodeMissing(
              context,
              values,
              context.explicitDefaults ? undefined : params.defaultValue,
            )) ?? params.decode(values);
      if (decoded.kind !== "present") {
        return decoded;
      }
      const selectedDeclaredChoice = params.options?.some(
        (choice) => choice.label.trim().toLowerCase() === values[0]?.trim().toLowerCase(),
      );
      const selectedOther =
        context.otherFieldId &&
        params.options &&
        values.some((value) => value !== "") &&
        !selectedDeclaredChoice;
      return {
        kind: "present",
        entries: [[selectedOther ? context.otherFieldId! : context.fieldId, decoded.value]],
      };
    },
  };
}

export function normalizeChoices(
  raw: Array<{ value: unknown; label: unknown; description?: unknown; thumbnail?: unknown }>,
  minimum: number,
  maximum = MAX_CHOICE_COUNT,
  maximumValueLength = MAX_CHOICE_VALUE,
): Choice[] | string {
  if (raw.length < minimum || raw.length > maximum) {
    return `must declare between ${minimum} and ${maximum} choices; choices are never truncated.`;
  }
  const choices: Choice[] = [];
  for (const entry of raw) {
    const description =
      entry.description === undefined || entry.description === null
        ? undefined
        : readStructuredInputText(entry.description, MAX_FIELD_TEXT);
    if (
      typeof entry.value !== "string" ||
      typeof entry.label !== "string" ||
      !entry.value ||
      !entry.label ||
      entry.value.length > maximumValueLength ||
      entry.label.length > MAX_CHOICE_LABEL ||
      hasUnsafeVisibleCharacters(entry.value) ||
      hasUnsafeVisibleCharacters(entry.label) ||
      (entry.description !== undefined && entry.description !== null && !description)
    ) {
      return "contains an invalid or over-limit choice.";
    }
    const thumbnail = isStructuredInputRecord(entry.thumbnail)
      ? ownValue(entry.thumbnail, "src")
      : undefined;
    if (entry.thumbnail !== undefined && !isQuestionThumbnail(thumbnail)) {
      return "contains an invalid or over-limit thumbnail.";
    }
    choices.push({
      value: entry.value,
      label: entry.label,
      ...(description ? { description } : {}),
      ...(typeof thumbnail === "string" ? { thumbnail } : {}),
    });
  }
  return validateChoices(choices) ?? choices;
}

export function validateChoices(choices: readonly Choice[]): string | undefined {
  const values = new Set<string>();
  const labels = new Set<string>();
  for (const choice of choices) {
    const value = choice.value.toLowerCase();
    const label = choice.label.trim().toLowerCase();
    if (values.has(value) || labels.has(label) || values.has(label) || labels.has(value)) {
      return "contains duplicate choice values or titles.";
    }
    values.add(value);
    labels.add(label);
  }
  return undefined;
}

function decodeMissing(
  context: FieldContext,
  values: readonly string[],
  defaultValue: StructuredInputAnswerValue | undefined,
): DecodeValue | undefined {
  if (values.some((value) => value !== "")) {
    return undefined;
  }
  if (defaultValue !== undefined) {
    return { kind: "present", value: defaultValue };
  }
  return context.required ? invalid(context, "is required.") : { kind: "absent" };
}

export function invalid(context: FieldContext, message: string): DecodeValue {
  return {
    kind: "invalid",
    message: boundText(`Field ${quote(context.fieldId)} ${message}`, 400),
  };
}

function matchesStringFormat(value: string, format: string): boolean {
  if (format === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  }
  if (format === "uri") {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  if (format === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      return false;
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
  }
  return /^\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value));
}

export function findChoice(
  choices: readonly Choice[],
  raw: string | undefined,
  canonical = false,
): Choice | undefined {
  if (canonical) {
    return choices.find((choice) => choice.value === raw);
  }
  const value = raw?.trim().toLowerCase();
  return choices.find(
    (choice) => choice.label.trim().toLowerCase() === value || choice.value.toLowerCase() === value,
  );
}

function displayDefault(value: StructuredInputAnswerValue): string {
  return boundText(Array.isArray(value) ? value.join(", ") : String(value), 80);
}
