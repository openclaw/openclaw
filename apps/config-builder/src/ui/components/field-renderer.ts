import { html, nothing, type TemplateResult } from "lit";
import type { ExplorerField, ExplorerSchemaNode, FieldKind } from "../../lib/schema-spike.ts";

type FieldRendererParams = {
  field: ExplorerField;
  value: unknown;
  onSet: (value: unknown) => void;
  onClear: () => void;
  onValidationError?: (message: string) => void;
  suggestions?: string[];
};

type ScalarKind = "string" | "number" | "integer" | "boolean" | "enum";

type ScalarControlParams = {
  kind: ScalarKind;
  enumValues: string[];
  value: unknown;
  sensitive?: boolean;
  compact?: boolean;
  onSet: (value: unknown) => void;
  onClear?: () => void;
  onValidationError?: (message: string) => void;
  suggestions?: string[];
};

type NodeRendererParams = {
  node: ExplorerSchemaNode | null;
  value: unknown;
  onSet: (value: unknown) => void;
  onClear?: () => void;
  onValidationError?: (message: string) => void;
  depth?: number;
  compact?: boolean;
  suggestions?: string[];
};

const MAX_EDITOR_DEPTH = 6;

function humanizeKey(value: string): string {
  if (!value.trim()) {
    return value;
  }
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function defaultValueForKind(kind: FieldKind, enumValues: string[] = []): unknown {
  if (kind === "boolean") {
    return false;
  }
  if (kind === "number" || kind === "integer") {
    return 0;
  }
  if (kind === "array") {
    return [];
  }
  if (kind === "object") {
    return {};
  }
  if (kind === "enum") {
    return enumValues[0] ?? "";
  }
  return "";
}

function defaultValueForNode(node: ExplorerSchemaNode | null): unknown {
  if (!node) {
    return "";
  }
  return defaultValueForKind(node.kind, node.enumValues);
}

function parseScalar(kind: FieldKind, raw: string): unknown {
  if (kind === "number") {
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
      throw new Error("Enter a valid number.");
    }
    return parsed;
  }

  if (kind === "integer") {
    const parsed = Number(raw);
    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
      throw new Error("Enter a valid integer.");
    }
    return Math.trunc(parsed);
  }

  if (kind === "boolean") {
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
    throw new Error("Use true or false.");
  }

  return raw;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function jsonValue(value: unknown): string {
  if (value === undefined) {
    return "{}";
  }
  try {
    return JSON.stringify(value, null, 2) ?? "{}";
  } catch {
    return "{}";
  }
}

function scalarInputValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function normalizeSuggestion(value: string): string {
  return value.trim().toLowerCase();
}

function dedupeSuggestions(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of values) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = normalizeSuggestion(trimmed);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(trimmed);
  }
  return out;
}

function subsequenceScore(query: string, candidate: string): number {
  let qi = 0;
  let score = 0;
  for (let i = 0; i < candidate.length && qi < query.length; i += 1) {
    if (candidate[i] === query[qi]) {
      score += i;
      qi += 1;
    }
  }
  if (qi !== query.length) {
    return Number.POSITIVE_INFINITY;
  }
  return score;
}

function fuzzyFilterSuggestions(options: string[], query: string, limit = 8): string[] {
  const unique = dedupeSuggestions(options);
  const normalizedQuery = normalizeSuggestion(query);

  if (!normalizedQuery) {
    return unique.slice(0, limit);
  }

  const ranked = unique
    .map((entry) => {
      const normalized = normalizeSuggestion(entry);

      if (normalized === normalizedQuery) {
        return { entry, score: 0 };
      }

      if (normalized.startsWith(normalizedQuery)) {
        return { entry, score: 1 + normalized.length / 1000 };
      }

      const includesAt = normalized.indexOf(normalizedQuery);
      if (includesAt >= 0) {
        return { entry, score: 2 + includesAt / 100 };
      }

      const subseq = subsequenceScore(normalizedQuery, normalized);
      if (Number.isFinite(subseq)) {
        return { entry, score: 3 + subseq / 1000 };
      }

      return null;
    })
    .filter((entry): entry is { entry: string; score: number } => entry !== null)
    .toSorted((a, b) => {
      if (a.score !== b.score) {
        return a.score - b.score;
      }
      if (a.entry.length !== b.entry.length) {
        return a.entry.length - b.entry.length;
      }
      return a.entry.localeCompare(b.entry);
    });

  return ranked.slice(0, limit).map((entry) => entry.entry);
}

function renderJsonControl(params: {
  kind: FieldKind;
  value: unknown;
  onSet: (value: unknown) => void;
  onValidationError?: (message: string) => void;
}): TemplateResult {
  const { kind, value, onSet, onValidationError } = params;
  const fallback = kind === "array" ? [] : {};

  return html`
    <label class="cfg-field">
      <span class="cfg-field__help">Edit as JSON (${kind})</span>
      <textarea
        class="cfg-textarea"
        rows="4"
        .value=${jsonValue(value ?? fallback)}
        @change=${(event: Event) => {
          const target = event.target as HTMLTextAreaElement;
          const raw = target.value.trim();
          if (!raw) {
            onSet(fallback);
            return;
          }
          try {
            onSet(JSON.parse(raw));
          } catch {
            onValidationError?.("Invalid JSON value.");
            target.value = jsonValue(value ?? fallback);
          }
        }}
      ></textarea>
    </label>
  `;
}

function renderScalarControl(params: ScalarControlParams): TemplateResult {
  const { kind, enumValues, value, sensitive, compact, onSet, onClear, onValidationError, suggestions } =
    params;

  if (kind === "boolean") {
    return html`
      <label class="cfg-toggle-row builder-toggle-row">
        <span class="cfg-field__help">Toggle value</span>
        <div class="cfg-toggle">
          <input
            type="checkbox"
            .checked=${value === true}
            @change=${(event: Event) => onSet((event.target as HTMLInputElement).checked)}
          />
          <span class="cfg-toggle__track"></span>
        </div>
      </label>
    `;
  }

  if (kind === "enum") {
    const selected = typeof value === "string" ? value : "";

    if (!compact && enumValues.length > 0 && enumValues.length <= 4) {
      return html`
        <div class="cfg-segmented">
          ${enumValues.map(
            (entry) => html`
              <button
                type="button"
                class="cfg-segmented__btn ${entry === selected ? "active" : ""}"
                @click=${() => onSet(entry)}
              >
                ${entry}
              </button>
            `,
          )}
          ${onClear
            ? html`
                <button
                  type="button"
                  class="cfg-segmented__btn ${selected ? "" : "active"}"
                  @click=${onClear}
                >
                  unset
                </button>
              `
            : nothing}
        </div>
      `;
    }

    return html`
      <select
        class="cfg-select ${compact ? "cfg-select--sm" : ""}"
        .value=${selected}
        @change=${(event: Event) => {
          const next = (event.target as HTMLSelectElement).value;
          if (!next) {
            if (onClear) {
              onClear();
            } else if (enumValues[0]) {
              onSet(enumValues[0]);
            }
            return;
          }
          onSet(next);
        }}
      >
        ${onClear ? html`<option value="">(unset)</option>` : nothing}
        ${enumValues.map((entry) => html`<option value=${entry}>${entry}</option>`) }
      </select>
    `;
  }

  const inputType = kind === "number" || kind === "integer" ? "number" : "text";
  const inputValue = scalarInputValue(value);

  const applyRawValue = (raw: string) => {
    if (raw.trim() === "") {
      if (onClear) {
        onClear();
      } else {
        onSet(defaultValueForKind(kind));
      }
      return;
    }

    try {
      onSet(parseScalar(kind, raw));
    } catch (error) {
      onValidationError?.(error instanceof Error ? error.message : String(error));
    }
  };

  const input = html`
    <input
      class="cfg-input ${compact ? "cfg-input--sm" : ""}"
      type=${sensitive ? "password" : inputType}
      .value=${inputValue}
      @input=${(event: Event) => {
        applyRawValue((event.target as HTMLInputElement).value);
      }}
    />
  `;

  if (kind !== "string") {
    return input;
  }

  const filteredSuggestions = fuzzyFilterSuggestions(suggestions ?? [], inputValue);
  if (filteredSuggestions.length === 0) {
    return input;
  }

  return html`
    <div class="cb-typeahead ${compact ? "cb-typeahead--compact" : ""}">
      ${input}
      <div class="cb-typeahead__menu" role="listbox" aria-label="Suggestions">
        ${filteredSuggestions.map((entry) => html`
          <button
            type="button"
            class="cb-typeahead__option"
            @mousedown=${(event: Event) => event.preventDefault()}
            @click=${() => onSet(entry)}
          >
            ${entry}
          </button>
        `)}
      </div>
    </div>
  `;
}

function renderArrayNodeControl(params: {
  node: ExplorerSchemaNode;
  value: unknown;
  onSet: (value: unknown) => void;
  onValidationError?: (message: string) => void;
  depth: number;
  suggestions?: string[];
}): TemplateResult {
  const { node, value, onSet, onValidationError, depth, suggestions } = params;
  const list = asArray(value);
  const itemNode = node.item;

  if (!itemNode || itemNode.kind === "unknown") {
    return renderJsonControl({ kind: "array", value, onSet, onValidationError });
  }

  return html`
    <div class="cfg-array">
      <div class="cfg-array__header">
        <span class="cfg-array__label">Items</span>
        <span class="cfg-array__count">${list.length} item${list.length === 1 ? "" : "s"}</span>
        <button
          type="button"
          class="cfg-array__add"
          @click=${() => onSet([...list, defaultValueForNode(itemNode)])}
        >
          Add
        </button>
      </div>

      ${list.length === 0
        ? html`<div class="cfg-array__empty">No items yet.</div>`
        : html`
            <div class="cfg-array__items">
              ${list.map((item, index) =>
                html`
                  <div class="cfg-array__item">
                    <div class="cfg-array__item-header">
                      <span class="cfg-array__item-index">#${index + 1}</span>
                      <button
                        type="button"
                        class="cfg-array__item-remove"
                        title="Remove item"
                        @click=${() => {
                          const next = [...list];
                          next.splice(index, 1);
                          onSet(next);
                        }}
                      >
                        ×
                      </button>
                    </div>
                    <div class="cfg-array__item-content">
                      ${renderNodeEditor({
                        node: itemNode,
                        value: item,
                        onSet: (nextValue) => {
                          const next = [...list];
                          next[index] = nextValue;
                          onSet(next);
                        },
                        onValidationError,
                        depth: depth + 1,
                        compact: true,
                        suggestions,
                      })}
                    </div>
                  </div>
                `,
              )}
            </div>
          `}
    </div>
  `;
}

function renderObjectNodeControl(params: {
  node: ExplorerSchemaNode;
  value: unknown;
  onSet: (value: unknown) => void;
  onValidationError?: (message: string) => void;
  depth: number;
  suggestions?: string[];
}): TemplateResult {
  const { node, value, onSet, onValidationError, depth, suggestions } = params;
  const record = asObject(value);

  const fixedEntries = Object.entries(node.properties);
  const fixedKeys = new Set(fixedEntries.map(([key]) => key));

  const extraSchema = node.additionalProperties;
  const extraEntries = Object.entries(record).filter(([key]) => !fixedKeys.has(key));

  const hasFixed = fixedEntries.length > 0;
  const canEditExtras = Boolean(extraSchema && extraSchema.kind !== "unknown");

  if (!hasFixed && !canEditExtras && node.allowsUnknownProperties) {
    return renderJsonControl({ kind: "object", value, onSet, onValidationError });
  }

  const setChildValue = (key: string, nextValue: unknown) => {
    const next = { ...record };
    next[key] = nextValue;
    onSet(next);
  };

  const clearChildValue = (key: string) => {
    const next = { ...record };
    delete next[key];
    onSet(next);
  };

  const addExtraEntry = () => {
    if (!extraSchema) {
      return;
    }
    const next = { ...record };
    let index = 1;
    let key = `key-${index}`;
    while (key in next) {
      index += 1;
      key = `key-${index}`;
    }
    next[key] = defaultValueForNode(extraSchema);
    onSet(next);
  };

  return html`
    <div class="cfg-object-stack">
      ${hasFixed
        ? html`
            <div class="cfg-map">
              <div class="cfg-map__header">
                <span class="cfg-map__label">Fields</span>
              </div>
              <div class="cfg-map__items">
                ${fixedEntries.map(([key, childNode]) => {
                  const childValue = record[key];
                  const hasValue = childValue !== undefined;

                  return html`
                    <div class="cfg-map__item">
                      <div class="cfg-map__item-key">
                        <span class="cfg-field__help">${humanizeKey(key)}</span>
                      </div>
                      <div class="cfg-map__item-value">
                        ${renderNodeEditor({
                          node: childNode,
                          value: childValue,
                          onSet: (nextValue) => setChildValue(key, nextValue),
                          onClear: () => clearChildValue(key),
                          onValidationError,
                          depth: depth + 1,
                          compact: true,
                          suggestions,
                        })}
                      </div>
                      <button
                        type="button"
                        class="cfg-map__item-remove"
                        title="Clear field"
                        ?disabled=${!hasValue}
                        @click=${() => clearChildValue(key)}
                      >
                        ×
                      </button>
                    </div>
                  `;
                })}
              </div>
            </div>
          `
        : nothing}

      ${canEditExtras && extraSchema
        ? html`
            <div class="cfg-map">
              <div class="cfg-map__header">
                <span class="cfg-map__label">Entries</span>
                <button type="button" class="cfg-map__add" @click=${addExtraEntry}>Add Entry</button>
              </div>

              ${extraEntries.length === 0
                ? html`<div class="cfg-map__empty">No entries yet.</div>`
                : html`
                    <div class="cfg-map__items">
                      ${extraEntries.map(([key, entryValue]) =>
                        html`
                          <div class="cfg-map__item">
                            <div class="cfg-map__item-key">
                              <input
                                type="text"
                                class="cfg-input cfg-input--sm"
                                .value=${key}
                                @change=${(event: Event) => {
                                  const nextKey = (event.target as HTMLInputElement).value.trim();
                                  if (!nextKey || nextKey === key || nextKey in record) {
                                    return;
                                  }
                                  const next = { ...record };
                                  next[nextKey] = next[key];
                                  delete next[key];
                                  onSet(next);
                                }}
                              />
                            </div>

                            <div class="cfg-map__item-value">
                              ${renderNodeEditor({
                                node: extraSchema,
                                value: entryValue,
                                onSet: (nextValue) => setChildValue(key, nextValue),
                                onValidationError,
                                depth: depth + 1,
                                compact: true,
                                suggestions,
                              })}
                            </div>

                            <button
                              type="button"
                              class="cfg-map__item-remove"
                              title="Remove entry"
                              @click=${() => clearChildValue(key)}
                            >
                              ×
                            </button>
                          </div>
                        `,
                      )}
                    </div>
                  `}
            </div>
          `
        : nothing}

      ${!hasFixed && !canEditExtras && !node.allowsUnknownProperties
        ? html`<div class="cfg-field__help">No editable keys in this object schema.</div>`
        : nothing}
    </div>
  `;
}

function renderNodeEditor(params: NodeRendererParams): TemplateResult {
  const { node, value, onSet, onClear, onValidationError, suggestions } = params;
  const depth = params.depth ?? 0;
  const compact = params.compact ?? false;

  if (!node || depth > MAX_EDITOR_DEPTH) {
    return renderJsonControl({ kind: "object", value, onSet, onValidationError });
  }

  if (
    node.kind === "string" ||
    node.kind === "number" ||
    node.kind === "integer" ||
    node.kind === "boolean" ||
    node.kind === "enum"
  ) {
    return renderScalarControl({
      kind: node.kind,
      enumValues: node.enumValues,
      value,
      onSet,
      onClear,
      onValidationError,
      compact,
      suggestions,
    });
  }

  if (node.kind === "array") {
    return renderArrayNodeControl({
      node,
      value,
      onSet,
      onValidationError,
      depth,
      suggestions,
    });
  }

  if (node.kind === "object") {
    return renderObjectNodeControl({
      node,
      value,
      onSet,
      onValidationError,
      depth,
      suggestions,
    });
  }

  return renderJsonControl({ kind: node.kind, value, onSet, onValidationError });
}

export function renderFieldEditor(params: FieldRendererParams): TemplateResult | typeof nothing {
  const { field, value, onSet, onClear, onValidationError, suggestions } = params;

  if (!field.editable) {
    return html`<div class="cfg-field__help">Read-only in this phase.</div>`;
  }

  if (
    field.kind === "string" ||
    field.kind === "number" ||
    field.kind === "integer" ||
    field.kind === "boolean" ||
    field.kind === "enum"
  ) {
    return renderScalarControl({
      kind: field.kind,
      enumValues: field.enumValues,
      value,
      sensitive: field.sensitive,
      onSet,
      onClear,
      onValidationError,
      suggestions,
    });
  }

  if (field.kind === "array" || field.kind === "object") {
    return renderNodeEditor({
      node: field.schemaNode,
      value,
      onSet,
      onValidationError,
      depth: 0,
      suggestions,
    });
  }

  return html`<div class="cfg-field__help">Unsupported schema node.</div>`;
}
