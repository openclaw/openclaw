import { html, nothing, type TemplateResult } from "lit";
import JSON5 from "json5";
import type { ConfigDraft } from "../../lib/config-store.ts";
import { iconImport, iconFile, iconX, iconCheck } from "./icons.ts";

export type ImportDialogState = {
  open: boolean;
  tab: "paste" | "upload";
  pasteValue: string;
  error: string | null;
  dragOver: boolean;
};

export function createImportDialogState(): ImportDialogState {
  return {
    open: false,
    tab: "paste",
    pasteValue: "",
    error: null,
    dragOver: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseInput(raw: string): { config: ConfigDraft; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { config: {}, error: "Input is empty." };
  }
  try {
    const parsed = JSON5.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return { config: {}, error: "Parsed value is not an object." };
    }
    return { config: parsed, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { config: {}, error: `Parse error: ${message}` };
  }
}

export type ImportCallbacks = {
  onReplace: (config: ConfigDraft) => void;
  onMerge: (config: ConfigDraft) => void;
  onClose: () => void;
  onStateChange: (state: ImportDialogState) => void;
};

export function renderImportDialog(
  state: ImportDialogState,
  hasExistingDraft: boolean,
  callbacks: ImportCallbacks,
): TemplateResult | typeof nothing {
  if (!state.open) {return nothing;}

  const handlePasteImport = (mode: "replace" | "merge") => {
    const { config, error } = parseInput(state.pasteValue);
    if (error) {
      callbacks.onStateChange({ ...state, error });
      return;
    }
    if (mode === "replace") {
      callbacks.onReplace(config);
    } else {
      callbacks.onMerge(config);
    }
    callbacks.onClose();
  };

  const handleFileContent = (content: string, mode: "replace" | "merge") => {
    const { config, error } = parseInput(content);
    if (error) {
      callbacks.onStateChange({ ...state, error });
      return;
    }
    if (mode === "replace") {
      callbacks.onReplace(config);
    } else {
      callbacks.onMerge(config);
    }
    callbacks.onClose();
  };

  const handleFileDrop = (e: DragEvent, mode: "replace" | "merge") => {
    e.preventDefault();
    callbacks.onStateChange({ ...state, dragOver: false });
    const file = e.dataTransfer?.files?.[0];
    if (!file) {return;}
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        handleFileContent(reader.result, mode);
      }
    };
    reader.readAsText(file);
  };

  const handleFilePick = (e: Event, mode: "replace" | "merge") => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) {return;}
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        handleFileContent(reader.result, mode);
      }
    };
    reader.readAsText(file);
  };

  return html`
    <div class="cb-palette-overlay" @click=${(e: Event) => {
      if (e.target === e.currentTarget) {callbacks.onClose();}
    }}>
      <div class="cb-import-dialog">
        <div class="cb-import-dialog__header">
          <div class="cb-import-dialog__title">
            ${iconImport} Import Config
          </div>
          <button class="cb-import-dialog__close" @click=${callbacks.onClose}>
            ${iconX}
          </button>
        </div>

        <div class="cb-import-dialog__tabs">
          <button
            class="cb-import-dialog__tab ${state.tab === "paste" ? "active" : ""}"
            @click=${() => callbacks.onStateChange({ ...state, tab: "paste", error: null })}
          >
            Paste JSON5
          </button>
          <button
            class="cb-import-dialog__tab ${state.tab === "upload" ? "active" : ""}"
            @click=${() => callbacks.onStateChange({ ...state, tab: "upload", error: null })}
          >
            Upload File
          </button>
        </div>

        <div class="cb-import-dialog__body">
          ${state.tab === "paste"
            ? html`
                <textarea
                  class="cb-import-dialog__textarea"
                  rows="10"
                  placeholder='Paste your openclaw.json or JSON5 content here…\n\n{\n  gateway: { port: 18789 },\n  agents: { ... }\n}'
                  .value=${state.pasteValue}
                  @input=${(e: Event) => {
                    callbacks.onStateChange({
                      ...state,
                      pasteValue: (e.target as HTMLTextAreaElement).value,
                      error: null,
                    });
                  }}
                ></textarea>
              `
            : html`
                <div
                  class="cb-import-dialog__drop-zone ${state.dragOver ? "cb-import-dialog__drop-zone--active" : ""}"
                  @dragover=${(e: DragEvent) => {
                    e.preventDefault();
                    if (!state.dragOver) {
                      callbacks.onStateChange({ ...state, dragOver: true });
                    }
                  }}
                  @dragleave=${() => {
                    callbacks.onStateChange({ ...state, dragOver: false });
                  }}
                  @drop=${(e: DragEvent) => handleFileDrop(e, hasExistingDraft ? "merge" : "replace")}
                >
                  <div class="cb-import-dialog__drop-icon">${iconFile}</div>
                  <div class="cb-import-dialog__drop-text">
                    Drop your config file here
                  </div>
                  <div class="cb-import-dialog__drop-sub">
                    or
                    <label class="cb-import-dialog__file-label">
                      browse files
                      <input
                        type="file"
                        accept=".json,.json5,.jsonc"
                        style="display:none"
                        @change=${(e: Event) => handleFilePick(e, hasExistingDraft ? "merge" : "replace")}
                      />
                    </label>
                  </div>
                </div>
              `}

          ${state.error
            ? html`<div class="cb-import-dialog__error">${state.error}</div>`
            : nothing}
        </div>

        ${state.tab === "paste"
          ? html`
              <div class="cb-import-dialog__footer">
                ${hasExistingDraft
                  ? html`
                      <button
                        class="btn btn--sm"
                        ?disabled=${!state.pasteValue.trim()}
                        @click=${() => handlePasteImport("merge")}
                      >
                        Merge with draft
                      </button>
                      <button
                        class="btn btn--sm danger"
                        ?disabled=${!state.pasteValue.trim()}
                        @click=${() => handlePasteImport("replace")}
                      >
                        Replace draft
                      </button>
                    `
                  : html`
                      <button
                        class="btn btn--sm primary"
                        ?disabled=${!state.pasteValue.trim()}
                        @click=${() => handlePasteImport("replace")}
                      >
                        ${iconCheck} Import
                      </button>
                    `}
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}
