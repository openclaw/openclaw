import { LitElement, html, nothing } from "lit";
import { TOOL_GROUPS } from "../../../../src/agents/tool-policy.ts";
import {
  clearFieldValue,
  getFieldValue,
  loadPersistedDraft,
  persistDraft,
  resetDraft,
  setFieldValue,
  type ConfigDraft,
} from "../lib/config-store.ts";
import { downloadJson5File, formatConfigJson5 } from "../lib/json5-format.ts";
import {
  buildExplorerSnapshot,
  type ExplorerField,
  type ExplorerSection,
  type ExplorerSnapshot,
} from "../lib/schema-spike.ts";
import { validateConfigDraft, type ValidationResult } from "../lib/validation.ts";
import { modeToHash, parseModeFromHash, type ConfigBuilderMode } from "./navigation.ts";
import { renderFieldEditor } from "./components/field-renderer.ts";
import {
  iconCheck,
  iconChevronDown,
  iconChevronLeft,
  iconCode,
  iconCopy,
  iconDownload,
  iconExternalLink,
  iconFile,
  iconGrid,
  iconMoon,
  iconPanelRight,
  iconSearch,
  iconShield,
  iconSparkles,
  iconSun,
  iconTrash,
  sectionIcon,
} from "./components/icons.ts";
import {
  createImportDialogState,
  renderImportDialog,
  type ImportDialogState,
} from "./components/import-dialog.ts";
import { WIZARD_STEPS, wizardStepByIndex, wizardStepFields } from "./wizard.ts";

type AppState =
  | { status: "loading" }
  | { status: "ready"; snapshot: ExplorerSnapshot }
  | { status: "error"; message: string };

type CopyState = "idle" | "copied" | "failed";

const COMMON_MODEL_IDS = [
  "anthropic/claude-opus-4-6",
  "anthropic/claude-sonnet-4-5",
  "openai/gpt-5.2",
  "openai/gpt-5-mini",
  "google/gemini-3-flash-preview",
  "openrouter/openai/gpt-5-mini",
  "xai/grok-4",
];

const TOOL_POLICY_BASE_SUGGESTIONS = Array.from(
  new Set([
    ...Object.keys(TOOL_GROUPS),
    ...Object.values(TOOL_GROUPS).flat(),
    "group:plugins",
  ]),
).toSorted((a, b) => a.localeCompare(b));

function isToolPolicyPath(path: string): boolean {
  const normalized = path.replace(/\[\]/g, ".*");
  return (
    /^tools\.(allow|alsoAllow|deny)$/.test(normalized) ||
    /^tools\.byProvider\.\*\.(allow|alsoAllow|deny)$/.test(normalized) ||
    /^tools\.sandbox\.tools\.(allow|alsoAllow|deny)$/.test(normalized) ||
    /^agents\.list\.\*\.tools\.(allow|alsoAllow|deny)$/.test(normalized) ||
    /^agents\.list\.\*\.tools\.byProvider\.\*\.(allow|alsoAllow|deny)$/.test(normalized) ||
    /^agents\.list\.\*\.tools\.sandbox\.tools\.(allow|alsoAllow|deny)$/.test(normalized)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function includesQuery(value: string, query: string): boolean {
  return value.toLowerCase().includes(query);
}

function matchesField(field: ExplorerField, query: string): boolean {
  if (!query) {return true;}
  return (
    includesQuery(field.path, query) ||
    includesQuery(field.label, query) ||
    includesQuery(field.help, query)
  );
}

function matchesSection(section: ExplorerSection, query: string): boolean {
  if (!query) {return true;}
  return (
    includesQuery(section.id, query) ||
    includesQuery(section.label, query) ||
    includesQuery(section.description, query)
  );
}

type PreviewTokenKind =
  | "text"
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "comment"
  | "punct";

type PreviewToken = {
  kind: PreviewTokenKind;
  value: string;
};

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$-]/.test(char);
}

function tokenizeJson5Line(line: string): PreviewToken[] {
  if (!line) {
    return [{ kind: "text", value: "" }];
  }

  const trimmed = line.trimStart();
  if (trimmed.startsWith("//")) {
    return [{ kind: "comment", value: line }];
  }

  const tokens: PreviewToken[] = [];
  let index = 0;

  const push = (kind: PreviewTokenKind, value: string) => {
    if (!value) {return;}
    const previous = tokens.at(-1);
    if (previous && previous.kind === kind) {
      previous.value += value;
      return;
    }
    tokens.push({ kind, value });
  };

  while (index < line.length) {
    const char = line[index] ?? "";

    if (/\s/.test(char)) {
      let end = index + 1;
      while (end < line.length && /\s/.test(line[end] ?? "")) {
        end += 1;
      }
      push("text", line.slice(index, end));
      index = end;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      let end = index + 1;
      while (end < line.length) {
        const current = line[end] ?? "";
        if (current === "\\") {
          end += 2;
          continue;
        }
        if (current === quote) {
          end += 1;
          break;
        }
        end += 1;
      }
      push("string", line.slice(index, end));
      index = end;
      continue;
    }

    const punct = "{}[]:,";
    if (punct.includes(char)) {
      push("punct", char);
      index += 1;
      continue;
    }

    const remaining = line.slice(index);
    const numberMatch = remaining.match(/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      const value = numberMatch[0] ?? "";
      push("number", value);
      index += value.length;
      continue;
    }

    if (isIdentifierStart(char)) {
      let end = index + 1;
      while (end < line.length && isIdentifierPart(line[end] ?? "")) {
        end += 1;
      }
      const ident = line.slice(index, end);

      let lookahead = end;
      while (lookahead < line.length && /\s/.test(line[lookahead] ?? "")) {
        lookahead += 1;
      }

      if (line[lookahead] === ":") {
        push("key", ident);
      } else if (ident === "true" || ident === "false") {
        push("boolean", ident);
      } else if (ident === "null") {
        push("null", ident);
      } else {
        push("text", ident);
      }

      index = end;
      continue;
    }

    push("text", char);
    index += 1;
  }

  return tokens;
}

const PREVIEW_COLLAPSED_KEY = "openclaw.config-builder.preview-collapsed";
const THEME_KEY = "openclaw.config-builder.theme";

function loadPreviewCollapsed(): boolean {
  try {
    return localStorage.getItem(PREVIEW_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function persistPreviewCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(PREVIEW_COLLAPSED_KEY, String(collapsed));
  } catch {
    // best-effort
  }
}

function loadTheme(): "dark" | "light" {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light") {return "light";}
  } catch {
    // ignore
  }
  return "dark";
}

function persistTheme(theme: "dark" | "light"): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // best-effort
  }
}

class ConfigBuilderApp extends LitElement {
  private state: AppState = { status: "loading" };
  private mode: ConfigBuilderMode = "landing";
  private config: ConfigDraft = {};
  private validation: ValidationResult = validateConfigDraft({});
  private selectedSectionId: string | null = null;
  private searchQuery = "";
  private fieldErrors: Record<string, string> = {};
  private wizardStepIndex = 0;
  private wizardComplete = false;
  private copyState: CopyState = "idle";
  private copyResetTimer: number | null = null;
  private previewCollapsed = false;
  private theme: "dark" | "light" = "dark";
  private expandedSections = new Set<string>();
  private commandPaletteOpen = false;
  private commandPaletteQuery = "";
  private commandPaletteIndex = 0;
  private importState: ImportDialogState = createImportDialogState();

  private suggestionCacheConfig: ConfigDraft | null = null;
  private modelSuggestionsCache: string[] = [];
  private authProfileSuggestionsCache: string[] = [];
  private toolPolicySuggestionsCache: string[] = [];

  private topbarScrolled = false;

  private readonly hashChangeHandler = () => this.handleHashChange();
  private readonly keydownHandler = (e: KeyboardEvent) => this.handleGlobalKeydown(e);
  private readonly scrollHandler = () => this.handleScroll();

  override createRenderRoot() {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.bootstrap();
    window.addEventListener("hashchange", this.hashChangeHandler);
    window.addEventListener("keydown", this.keydownHandler);
    window.addEventListener("scroll", this.scrollHandler, { passive: true });
  }

  override disconnectedCallback(): void {
    window.removeEventListener("hashchange", this.hashChangeHandler);
    window.removeEventListener("keydown", this.keydownHandler);
    window.removeEventListener("scroll", this.scrollHandler);
    if (this.copyResetTimer != null) {
      window.clearTimeout(this.copyResetTimer);
      this.copyResetTimer = null;
    }
    super.disconnectedCallback();
  }

  private bootstrap(): void {
    try {
      this.mode = parseModeFromHash(window.location.hash);
      this.config = loadPersistedDraft();
      this.validation = validateConfigDraft(this.config);
      this.previewCollapsed = loadPreviewCollapsed();
      this.theme = loadTheme();
      this.applyTheme();
      const snapshot = buildExplorerSnapshot();
      this.state = { status: "ready", snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      this.state = { status: "error", message };
    }
    this.requestUpdate();
  }

  private applyTheme(): void {
    if (this.theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  private toggleTheme(): void {
    this.theme = this.theme === "dark" ? "light" : "dark";
    persistTheme(this.theme);
    this.applyTheme();
    this.requestUpdate();
  }

  private handleHashChange(): void {
    const next = parseModeFromHash(window.location.hash);
    if (next === this.mode) {return;}
    this.mode = next;
    if (next !== "wizard") {
      this.wizardStepIndex = 0;
      this.wizardComplete = false;
    }
    this.requestUpdate();
  }

  private navigateMode(mode: ConfigBuilderMode): void {
    if (mode !== this.mode) {
      this.mode = mode;
      this.requestUpdate();
    }
    const hash = modeToHash(mode);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
    if (mode === "wizard") {
      this.wizardComplete = false;
      this.focusWizardStep();
    }
  }

  private handleScroll(): void {
    const scrolled = window.scrollY > 4;
    if (scrolled !== this.topbarScrolled) {
      this.topbarScrolled = scrolled;
      this.requestUpdate();
    }
  }

  private handleGlobalKeydown(e: KeyboardEvent): void {
    const isMod = e.metaKey || e.ctrlKey;
    // ⌘K — command palette
    if (isMod && e.key === "k") {
      e.preventDefault();
      this.commandPaletteOpen = !this.commandPaletteOpen;
      this.commandPaletteQuery = "";
      this.commandPaletteIndex = 0;
      this.requestUpdate();
      if (this.commandPaletteOpen) {
        window.setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>(".cb-palette__input");
          input?.focus();
        }, 50);
      }
      return;
    }
    // ⌘\ — toggle preview
    if (isMod && e.key === "\\") {
      e.preventDefault();
      this.togglePreview();
      return;
    }
    // ⌘S — download
    if (isMod && e.key === "s") {
      e.preventDefault();
      const preview = formatConfigJson5(this.config);
      downloadJson5File(preview.text);
      return;
    }
    // Escape — close palette
    if (e.key === "Escape" && this.commandPaletteOpen) {
      this.commandPaletteOpen = false;
      this.requestUpdate();
      return;
    }
  }

  // --- State mutations ---

  private setSection(sectionId: string | null): void {
    this.selectedSectionId = sectionId;
    // Auto-expand the selected section
    if (sectionId) {
      this.expandedSections.add(sectionId);
    }
    this.requestUpdate();
  }

  private toggleSection(sectionId: string): void {
    if (this.expandedSections.has(sectionId)) {
      this.expandedSections.delete(sectionId);
    } else {
      this.expandedSections.add(sectionId);
    }
    this.requestUpdate();
  }

  private setSearchQuery(raw: string): void {
    this.searchQuery = raw.trim().toLowerCase();
    this.requestUpdate();
  }

  private saveConfig(next: ConfigDraft): void {
    this.config = next;
    this.validation = validateConfigDraft(next);
    this.suggestionCacheConfig = null;
    persistDraft(next);
    this.requestUpdate();
  }

  private collectModelSuggestionsFromConfig(): string[] {
    const suggestions = new Set<string>(COMMON_MODEL_IDS);

    const catalog = getFieldValue(this.config, "agents.defaults.models");
    if (isRecord(catalog)) {
      for (const key of Object.keys(catalog)) {
        if (key.trim()) {
          suggestions.add(key.trim());
        }
      }
    }

    const visit = (value: unknown): void => {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.includes("/") && !trimmed.includes("://")) {
          suggestions.add(trimmed);
        }
        return;
      }

      if (Array.isArray(value)) {
        for (const entry of value) {
          visit(entry);
        }
        return;
      }

      if (isRecord(value)) {
        for (const entry of Object.values(value)) {
          visit(entry);
        }
      }
    };

    visit(this.config);

    return Array.from(suggestions).toSorted((a, b) => a.localeCompare(b));
  }

  private collectAuthProfileSuggestionsFromConfig(): string[] {
    const profiles = getFieldValue(this.config, "auth.profiles");
    if (!isRecord(profiles)) {
      return [];
    }
    return Object.keys(profiles)
      .map((value) => value.trim())
      .filter(Boolean)
      .toSorted((a, b) => a.localeCompare(b));
  }

  private collectToolPolicySuggestionsFromConfig(): string[] {
    const suggestions = new Set<string>(TOOL_POLICY_BASE_SUGGESTIONS);

    const pluginEntries = getFieldValue(this.config, "plugins.entries");
    if (isRecord(pluginEntries)) {
      for (const pluginId of Object.keys(pluginEntries)) {
        const trimmed = pluginId.trim();
        if (trimmed) {
          suggestions.add(trimmed);
        }
      }
    }

    return Array.from(suggestions).toSorted((a, b) => a.localeCompare(b));
  }

  private refreshSuggestionCaches(): void {
    if (this.suggestionCacheConfig === this.config) {
      return;
    }
    this.suggestionCacheConfig = this.config;
    this.modelSuggestionsCache = this.collectModelSuggestionsFromConfig();
    this.authProfileSuggestionsCache = this.collectAuthProfileSuggestionsFromConfig();
    this.toolPolicySuggestionsCache = this.collectToolPolicySuggestionsFromConfig();
  }

  private fieldSuggestions(field: ExplorerField): string[] {
    this.refreshSuggestionCaches();

    const suggestions = new Set<string>();
    const addMany = (values: string[]) => {
      for (const value of values) {
        const trimmed = value.trim();
        if (trimmed) {
          suggestions.add(trimmed);
        }
      }
    };

    // Schema-derived suggestions (including open unions like enum + string).
    if (field.kind === "string" && field.enumValues.length > 0) {
      addMany(field.enumValues);
    }
    if (field.kind === "array" && field.itemKind === "string" && field.itemEnumValues.length > 0) {
      addMany(field.itemEnumValues);
    }
    if (
      field.kind === "object" &&
      field.recordValueKind === "string" &&
      field.recordEnumValues.length > 0
    ) {
      addMany(field.recordEnumValues);
    }

    // Runtime-derived suggestions.
    if (/model/i.test(field.path)) {
      addMany(this.modelSuggestionsCache);
    }

    if (field.path === "auth.order") {
      addMany(this.authProfileSuggestionsCache);
    }

    if (isToolPolicyPath(field.path)) {
      addMany(this.toolPolicySuggestionsCache);
    }

    return Array.from(suggestions).toSorted((a, b) => a.localeCompare(b));
  }

  private setFieldError(path: string, message: string): void {
    this.fieldErrors = { ...this.fieldErrors, [path]: message };
    this.requestUpdate();
  }

  private clearFieldError(path: string): void {
    if (!(path in this.fieldErrors)) {return;}
    const next = { ...this.fieldErrors };
    delete next[path];
    this.fieldErrors = next;
  }

  private clearField(path: string): void {
    this.clearFieldError(path);
    this.saveConfig(clearFieldValue(this.config, path));
  }

  private setField(path: string, value: unknown): void {
    this.clearFieldError(path);
    this.saveConfig(setFieldValue(this.config, path, value));
  }

  private resetAllFields(): void {
    this.fieldErrors = {};
    this.saveConfig(resetDraft());
  }

  private openImportDialog(): void {
    this.importState = createImportDialogState();
    this.importState.open = true;
    this.requestUpdate();
  }

  private deepMergeConfig(incoming: ConfigDraft): void {
    const merged = this.deepMerge(this.config, incoming);
    this.saveConfig(merged);
  }

  private deepMerge(
    base: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      const existing = result[key];
      if (
        typeof value === "object" && value !== null && !Array.isArray(value) &&
        typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ) {
        result[key] = this.deepMerge(
          existing as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private sectionErrorCount(sectionId: string): number {
    return this.validation.sectionErrorCounts[sectionId] ?? 0;
  }

  private sectionSetCount(section: ExplorerSection): number {
    return section.fields.filter((f) => getFieldValue(this.config, f.path) !== undefined).length;
  }

  private totalErrorCount(): number {
    return this.validation.issues.length;
  }

  private togglePreview(): void {
    this.previewCollapsed = !this.previewCollapsed;
    persistPreviewCollapsed(this.previewCollapsed);
    this.requestUpdate();
  }

  private async copyPreview(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copyState = "copied";
    } catch {
      this.copyState = "failed";
    }
    if (this.copyResetTimer != null) {window.clearTimeout(this.copyResetTimer);}
    this.copyResetTimer = window.setTimeout(() => {
      this.copyState = "idle";
      this.copyResetTimer = null;
      this.requestUpdate();
    }, 1500);
    this.requestUpdate();
  }

  private setWizardStep(index: number): void {
    const clamped = Math.max(0, Math.min(WIZARD_STEPS.length - 1, index));
    if (clamped === this.wizardStepIndex) {return;}
    this.wizardStepIndex = clamped;
    this.wizardComplete = false;
    this.requestUpdate();
    this.focusWizardStep();
  }

  private focusWizardStep(): void {
    window.setTimeout(() => {
      const root = document.querySelector(".cb-wizard");
      const target = root?.querySelector<HTMLElement>("input, select, textarea, button");
      target?.focus();
    }, 0);
  }

  private getVisibleSections(snapshot: ExplorerSnapshot): ExplorerSection[] {
    const bySection = this.selectedSectionId
      ? snapshot.sections.filter((s) => s.id === this.selectedSectionId)
      : snapshot.sections;

    const query = this.searchQuery;
    if (!query) {return bySection;}

    const visible: ExplorerSection[] = [];
    for (const section of bySection) {
      if (matchesSection(section, query)) {
        visible.push(section);
        continue;
      }
      const fields = section.fields.filter((f) => matchesField(f, query));
      if (fields.length === 0) {continue;}
      visible.push({ ...section, fields });
    }
    return visible;
  }

  private sensitiveFieldsWithValues(snapshot: ExplorerSnapshot): string[] {
    const paths: string[] = [];
    for (const section of snapshot.sections) {
      for (const field of section.fields) {
        if (!field.sensitive) {continue;}
        if (getFieldValue(this.config, field.path) === undefined) {continue;}
        paths.push(field.path);
      }
    }
    return paths;
  }

  private getCommandPaletteResults(snapshot: ExplorerSnapshot): ExplorerField[] {
    const q = this.commandPaletteQuery.trim().toLowerCase();
    const results: ExplorerField[] = [];
    for (const section of snapshot.sections) {
      for (const field of section.fields) {
        if (!q || matchesField(field, q)) {
          results.push(field);
        }
        if (results.length >= 20) {return results;}
      }
    }
    return results;
  }

  // --- Renderers ---

  private renderTopbar() {
    const modeButton = (mode: ConfigBuilderMode, label: string) => html`
      <button
        class="cb-topbar__nav-btn ${this.mode === mode ? "active" : ""}"
        @click=${() => this.navigateMode(mode)}
      >${label}</button>
    `;

    return html`
      <header class="cb-topbar ${this.topbarScrolled ? "cb-topbar--scrolled" : ""}"
        <div class="cb-topbar__brand">
          <div class="cb-topbar__logo">OC</div>
          <span class="cb-topbar__title">Config Builder</span>
        </div>

        <nav class="cb-topbar__nav" role="tablist">
          ${modeButton("landing", "Home")}
          ${modeButton("explorer", "Explorer")}
          ${modeButton("wizard", "Wizard")}
        </nav>

        <div class="cb-topbar__actions">
          <button
            class="cb-search-trigger"
            @click=${() => {
              this.commandPaletteOpen = true;
              this.commandPaletteQuery = "";
              this.commandPaletteIndex = 0;
              this.requestUpdate();
              window.setTimeout(() => {
                const input = document.querySelector<HTMLInputElement>(".cb-palette__input");
                input?.focus();
              }, 50);
            }}
          >
            ${iconSearch}
            <span>Search fields…</span>
            <kbd>⌘K</kbd>
          </button>

          <button class="cb-theme-toggle" @click=${() => this.toggleTheme()} title="Toggle theme">
            ${this.theme === "dark" ? iconSun : iconMoon}
          </button>

          <a class="btn btn--sm" href="https://docs.openclaw.ai/configuration" target="_blank" rel="noreferrer">
            ${iconExternalLink} Docs
          </a>
        </div>
      </header>
    `;
  }

  private renderLanding(snapshot: ExplorerSnapshot) {
    return html`
      <div class="cb-landing">
        <div class="cb-landing__hero">
          <h1 class="cb-landing__heading">Config Builder</h1>
          <p class="cb-landing__sub">
            Build your <code style="font-family:var(--mono);font-size:0.9em">openclaw.json</code> visually.
            Guided wizard or full schema explorer — your config never leaves your browser.
          </p>
        </div>

        <div class="cb-landing__cards">
          <div class="cb-landing__card cb-landing__card--primary" @click=${() => this.navigateMode("wizard")}>
            <div class="cb-landing__card-icon">${iconSparkles}</div>
            <div class="cb-landing__card-title">Guided Setup</div>
            <div class="cb-landing__card-meta">${WIZARD_STEPS.length} steps · ~5 min</div>
            <div class="cb-landing__card-desc">
              Walk through the most important settings step by step. Perfect for first-time setup.
            </div>
            <div class="cb-landing__card-cta">
              <button class="btn primary">Start Wizard</button>
            </div>
          </div>

          <div class="cb-landing__card" @click=${() => this.navigateMode("explorer")}>
            <div class="cb-landing__card-icon">${iconGrid}</div>
            <div class="cb-landing__card-title">Full Explorer</div>
            <div class="cb-landing__card-meta">${snapshot.sectionCount} sections · ${snapshot.fieldCount} fields</div>
            <div class="cb-landing__card-desc">
              Browse every schema-backed field with search, filtering, and real-time validation.
            </div>
            <div class="cb-landing__card-cta">
              <button class="btn">Open Explorer</button>
            </div>
          </div>
        </div>

        <div class="cb-landing__import">
          or <a @click=${() => this.openImportDialog()}>import an existing config</a>
        </div>

        <div class="cb-landing__features">
          <span class="cb-landing__feature">${iconCheck} Real-time validation</span>
          <span class="cb-landing__feature">${iconCode} JSON5 output</span>
          <span class="cb-landing__feature">${iconShield} Schema-backed</span>
          <span class="cb-landing__feature">${iconFile} LocalStorage draft</span>
        </div>

        <div class="cb-landing__footer">
          All processing happens client-side. Your config data never leaves your browser.
        </div>
      </div>
    `;
  }

  private renderSidebar(snapshot: ExplorerSnapshot) {
    return html`
      <aside class="cb-sidebar">
        <div class="cb-sidebar__header">
          <span class="cb-sidebar__title">Sections</span>
          <span class="pill pill--sm ${this.validation.valid ? "pill--ok" : "pill--danger"}">
            ${this.validation.valid ? "valid" : `${this.totalErrorCount()} errors`}
          </span>
        </div>

        <div class="cb-sidebar__search">
          <span class="cb-sidebar__search-icon">${iconSearch}</span>
          <input
            class="cb-sidebar__search-input"
            type="text"
            placeholder="Filter sections…"
            .value=${this.searchQuery}
            @input=${(e: Event) => this.setSearchQuery((e.target as HTMLInputElement).value)}
          />
          ${this.searchQuery
            ? html`<button class="cb-sidebar__search-clear" @click=${() => this.setSearchQuery("")}>×</button>`
            : nothing}
        </div>

        <nav class="cb-sidebar__nav">
          <button
            class="cb-sidebar__nav-item ${this.selectedSectionId === null ? "active" : ""}"
            @click=${() => this.setSection(null)}
          >
            <span class="cb-sidebar__nav-icon">${iconGrid}</span>
            <span class="cb-sidebar__nav-label">All</span>
            <span class="cb-sidebar__nav-count">${snapshot.fieldCount}</span>
          </button>

          ${snapshot.sections.map((section) => {
            const setCount = this.sectionSetCount(section);
            const errCount = this.sectionErrorCount(section.id);
            return html`
              <button
                class="cb-sidebar__nav-item ${this.selectedSectionId === section.id ? "active" : ""}"
                @click=${() => this.setSection(section.id)}
              >
                <span class="cb-sidebar__nav-icon">${sectionIcon(section.id)}</span>
                <span class="cb-sidebar__nav-label">${section.label}</span>
                <span class="cb-sidebar__nav-count ${setCount > 0 ? "cb-sidebar__nav-count--active" : ""}">
                  ${setCount}/${section.fields.length}
                </span>
                ${errCount > 0
                  ? html`<span class="cb-sidebar__nav-errors">${errCount}</span>`
                  : nothing}
              </button>
            `;
          })}
        </nav>

        <div class="cb-sidebar__footer">
          Draft auto-saved to localStorage.<br />
          Validation updates in real time.
        </div>
      </aside>
    `;
  }

  private renderField(field: ExplorerField, context: "explorer" | "wizard") {
    const value = getFieldValue(this.config, field.path);
    const hasValue = value !== undefined;
    const localError = this.fieldErrors[field.path] ?? null;
    const schemaErrors = this.validation.issuesByPath[field.path] ?? [];
    const hasError = Boolean(localError) || schemaErrors.length > 0;

    return html`
      <div class="cb-field ${hasValue ? "cb-field--set" : ""} ${hasError ? "cb-field--error" : ""}">
        <div class="cb-field__header">
          <span class="cb-field__label">${field.label}</span>
          <div class="cb-field__badges">
            ${field.sensitive ? html`<span class="cb-field__badge cb-field__badge--sensitive">🔒 sensitive</span>` : nothing}
            <span class="cb-field__badge">${field.kind}</span>
          </div>
        </div>

        <div class="cb-field__path">${field.path}</div>

        ${field.help ? html`<div class="cb-field__help">${field.help}</div>` : nothing}

        <div class="cb-field__control">
          ${renderFieldEditor({
            field,
            value,
            onSet: (v: unknown) => this.setField(field.path, v),
            onClear: () => this.clearField(field.path),
            onValidationError: (msg: string) => this.setFieldError(field.path, msg),
            suggestions: this.fieldSuggestions(field),
          })}
        </div>

        ${localError ? html`<div class="cb-field__error">${localError}</div>` : nothing}
        ${schemaErrors.map((msg) => html`<div class="cb-field__error">${msg}</div>`)}

        <div class="cb-field__actions">
          ${context === "wizard"
            ? html`<button class="btn btn--sm" @click=${() => this.navigateMode("explorer")}>Open in Explorer</button>`
            : nothing}
          <button class="btn btn--sm cb-field__clear-btn" @click=${() => this.clearField(field.path)}>Clear</button>
        </div>
      </div>
    `;
  }

  private renderSectionCard(section: ExplorerSection, index: number) {
    const isOpen = this.expandedSections.has(section.id) ||
      this.selectedSectionId === section.id ||
      Boolean(this.searchQuery);
    const setCount = this.sectionSetCount(section);
    const errCount = this.sectionErrorCount(section.id);
    const stagger = Math.min(index + 1, 10);

    return html`
      <div class="cb-section ${isOpen ? "cb-section--open" : ""} cb-stagger-${stagger}">
        <div class="cb-section__header" @click=${() => this.toggleSection(section.id)}>
          <span class="cb-section__icon">${sectionIcon(section.id)}</span>
          <div class="cb-section__info">
            <div class="cb-section__title">${section.label}</div>
            ${section.description
              ? html`<div class="cb-section__desc">${section.description}</div>`
              : nothing}
          </div>
          <div class="cb-section__meta">
            <span class="cb-section__count ${setCount > 0 ? "cb-section__count--has-values" : ""}">
              ${setCount}/${section.fields.length}
            </span>
            ${errCount > 0
              ? html`<span class="cb-section__error-count">${errCount}</span>`
              : nothing}
          </div>
          <span class="cb-section__chevron">${iconChevronDown}</span>
        </div>
        <div class="cb-section__body">
          <div class="cb-section__body-inner">
            <div class="cb-section__fields">
              ${section.fields.map((field) => this.renderField(field, "explorer"))}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderExplorer(snapshot: ExplorerSnapshot) {
    const visibleSections = this.getVisibleSections(snapshot);

    return html`
      ${this.renderSidebar(snapshot)}

      <main class="cb-main">
        <div class="cb-actions">
          <div class="cb-actions__left">
            <span class="cb-actions__status">
              ${this.selectedSectionId
                ? `${visibleSections[0]?.label ?? "Section"}`
                : this.searchQuery
                  ? `Search: "${this.searchQuery}"`
                  : "All sections"}
            </span>
          </div>
          <div class="cb-actions__right">
            <span class="pill pill--sm mono">v${snapshot.version}</span>
            ${this.totalErrorCount() > 0
              ? html`<span class="pill pill--sm pill--danger">${this.totalErrorCount()} errors</span>`
              : html`<span class="pill pill--sm pill--ok">valid</span>`}
          </div>
        </div>

        <div class="cb-content">
          ${visibleSections.length === 0
            ? html`
                <div class="cb-empty">
                  <div class="cb-empty__icon">${iconSearch}</div>
                  <div class="cb-empty__text">No matching sections or fields</div>
                  <div class="cb-empty__sub">Try a different search term</div>
                </div>
              `
            : html`
                <div class="cb-sections">
                  ${visibleSections.map((section, i) => this.renderSectionCard(section, i))}
                </div>
              `}
        </div>
      </main>
    `;
  }

  private renderWizardStepper() {
    return html`
      <div class="cb-stepper">
        ${WIZARD_STEPS.map((step, index) => {
          const state =
            this.wizardComplete || index < this.wizardStepIndex
              ? "done"
              : index === this.wizardStepIndex && !this.wizardComplete
                ? "active"
                : "future";

          return html`
            ${index > 0 ? html`<div class="cb-stepper__line ${index <= this.wizardStepIndex ? "cb-stepper__line--done" : ""}"></div>` : nothing}
            <button
              class="cb-stepper__step cb-stepper__step--${state}"
              @click=${() => { this.wizardComplete = false; this.setWizardStep(index); }}
            >
              <span class="cb-stepper__circle">
                ${state === "done" ? iconCheck : `${index + 1}`}
              </span>
              <span class="cb-stepper__label">${step.label}</span>
            </button>
          `;
        })}
      </div>
    `;
  }

  private renderWizardContent() {
    if (this.wizardComplete) {
      const setCount = Object.keys(this.config).length > 0
        ? WIZARD_STEPS.reduce(
            (sum, step) =>
              sum +
              wizardStepFields(step).filter(
                (f) => getFieldValue(this.config, f.path) !== undefined,
              ).length,
            0,
          )
        : 0;

      return html`
        <div class="cb-wizard__complete">
          <div class="cb-wizard__complete-icon">${iconCheck}</div>
          <div class="cb-wizard__complete-title">Your config is ready!</div>
          <div class="cb-wizard__complete-sub">
            ${setCount} field${setCount === 1 ? "" : "s"} configured across ${WIZARD_STEPS.length} steps
          </div>
          <div class="cb-wizard__complete-actions">
            <button class="btn primary" @click=${() => {
              const preview = formatConfigJson5(this.config);
              downloadJson5File(preview.text);
            }}>
              ${iconDownload} Download JSON5
            </button>
            <button class="btn" @click=${() => this.navigateMode("explorer")}>
              ${iconGrid} Open in Explorer
            </button>
          </div>
        </div>
      `;
    }

    const step = wizardStepByIndex(this.wizardStepIndex);
    const fields = wizardStepFields(step);
    const isLast = this.wizardStepIndex >= WIZARD_STEPS.length - 1;

    return html`
      <div class="cb-wizard__card">
        <div class="cb-wizard__card-header">
          <span class="cb-wizard__card-icon">${sectionIcon(step.id)}</span>
          <div>
            <div class="cb-wizard__card-title">${step.label}</div>
            <div class="cb-wizard__card-desc">${step.description}</div>
          </div>
        </div>

        <div class="cb-wizard__card-body">
          <div class="cb-wizard__card-fields">
            ${fields.map((field) => this.renderField(field, "wizard"))}
          </div>
        </div>

        <div class="cb-wizard__actions">
          <div class="cb-wizard__actions-left">
            <button
              class="btn btn--sm"
              ?disabled=${this.wizardStepIndex === 0}
              @click=${() => this.setWizardStep(this.wizardStepIndex - 1)}
            >
              ${iconChevronLeft} Back
            </button>
          </div>
          <div class="cb-wizard__actions-right">
            <button
              class="cb-wizard__skip"
              @click=${() => {
                if (isLast) {
                  this.wizardComplete = true;
                  this.requestUpdate();
                  return;
                }
                this.setWizardStep(this.wizardStepIndex + 1);
              }}
            >
              Skip this step
            </button>
            <button
              class="btn btn--sm primary"
              @click=${() => {
                if (isLast) {
                  this.wizardComplete = true;
                  this.requestUpdate();
                  return;
                }
                this.setWizardStep(this.wizardStepIndex + 1);
              }}
            >
              ${isLast ? html`${iconSparkles} Finish & Review` : "Continue →"}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderWizard() {
    return html`
      <main class="cb-main">
        <div class="cb-actions">
          <div class="cb-actions__left">
            <span class="cb-actions__status">
              ${this.wizardComplete
                ? "Setup complete"
                : `Step ${this.wizardStepIndex + 1} of ${WIZARD_STEPS.length}`}
            </span>
          </div>
          <div class="cb-actions__right">
            ${this.totalErrorCount() > 0
              ? html`<span class="pill pill--sm pill--danger">${this.totalErrorCount()} errors</span>`
              : html`<span class="pill pill--sm pill--ok">valid</span>`}
          </div>
        </div>

        <div class="cb-content">
          <div class="cb-wizard">
            ${this.renderWizardStepper()}
            ${this.renderWizardContent()}
          </div>
        </div>
      </main>
    `;
  }

  private renderPreviewCode(text: string) {
    const rawLines = text.split(/\r?\n/);
    const lines = rawLines.at(-1) === "" ? rawLines.slice(0, -1) : rawLines;

    return html`<div class="cb-code-lines">${lines.map((line, index) => {
      const tokens = tokenizeJson5Line(line);
      return html`<div class="cb-code-line"><span class="cb-code-line__num">${index + 1}</span><span class="cb-code-line__content">${tokens.map((token) => html`<span class="cb-code-token cb-code-token--${token.kind}">${token.value}</span>`)}</span></div>`;
    })}</div>`;
  }

  private renderPreview(snapshot: ExplorerSnapshot) {
    const collapsed = this.previewCollapsed;
    const preview = formatConfigJson5(this.config);
    const sensitivePaths = this.sensitiveFieldsWithValues(snapshot);

    return html`
      <aside class="cb-preview ${collapsed ? "cb-preview--collapsed" : ""}">
        <div class="cb-preview__header">
          <div class="cb-preview__title-group">
            <span class="cb-preview__file-icon">${iconFile}</span>
            <span class="cb-preview__title">openclaw.json</span>
            <span class="cb-preview__meta">${preview.lineCount} lines</span>
          </div>
          <button
            class="cb-preview__toggle"
            @click=${() => this.togglePreview()}
            title="${collapsed ? "Show preview" : "Hide preview"}"
          >
            ${iconPanelRight}
          </button>
        </div>

        ${sensitivePaths.length > 0 && !collapsed
          ? html`
              <div class="cb-preview__warning">
                ${iconShield}
                ${sensitivePaths.length} sensitive value${sensitivePaths.length === 1 ? "" : "s"} in output
              </div>
            `
          : nothing}

        <div class="cb-preview__code">${this.renderPreviewCode(preview.text)}</div>

        <div class="cb-preview__footer">
          <button class="btn btn--sm" @click=${() => this.copyPreview(preview.text)}>
            ${this.copyState === "copied" ? iconCheck : iconCopy}
            ${this.copyState === "copied" ? "Copied!" : this.copyState === "failed" ? "Failed" : "Copy"}
          </button>
          <button class="btn btn--sm" @click=${() => downloadJson5File(preview.text)}>
            ${iconDownload} Download
          </button>
          <span class="cb-preview__spacer"></span>
          <button class="btn btn--sm danger" @click=${() => this.resetAllFields()}>
            ${iconTrash} Reset
          </button>
        </div>
      </aside>
    `;
  }

  private renderCommandPalette(snapshot: ExplorerSnapshot) {
    if (!this.commandPaletteOpen) {return nothing;}

    const results = this.getCommandPaletteResults(snapshot);

    return html`
      <div class="cb-palette-overlay" @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          this.commandPaletteOpen = false;
          this.requestUpdate();
        }
      }}>
        <div class="cb-palette">
          <div class="cb-palette__input-wrap">
            <span class="cb-palette__input-icon">${iconSearch}</span>
            <input
              class="cb-palette__input"
              type="text"
              placeholder="Search fields…"
              .value=${this.commandPaletteQuery}
              @input=${(e: Event) => {
                this.commandPaletteQuery = (e.target as HTMLInputElement).value;
                this.commandPaletteIndex = 0;
                this.requestUpdate();
              }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  this.commandPaletteIndex = Math.min(this.commandPaletteIndex + 1, results.length - 1);
                  this.requestUpdate();
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  this.commandPaletteIndex = Math.max(this.commandPaletteIndex - 1, 0);
                  this.requestUpdate();
                } else if (e.key === "Enter" && results[this.commandPaletteIndex]) {
                  e.preventDefault();
                  const field = results[this.commandPaletteIndex];
                  if (field) {
                    const sectionId = field.path.split(".")[0] ?? null;
                    this.commandPaletteOpen = false;
                    this.navigateMode("explorer");
                    this.setSection(sectionId);
                    if (sectionId) {this.expandedSections.add(sectionId);}
                    this.requestUpdate();
                  }
                }
              }}
            />
          </div>
          <div class="cb-palette__results">
            ${results.length === 0
              ? html`<div class="cb-palette__empty">No fields match your search</div>`
              : results.map((field, i) => {
                  const val = getFieldValue(this.config, field.path);
                  return html`
                    <div
                      class="cb-palette__result ${i === this.commandPaletteIndex ? "cb-palette__result--active" : ""}"
                      @click=${() => {
                        const sectionId = field.path.split(".")[0] ?? null;
                        this.commandPaletteOpen = false;
                        this.navigateMode("explorer");
                        this.setSection(sectionId);
                        if (sectionId) {this.expandedSections.add(sectionId);}
                        this.requestUpdate();
                      }}
                    >
                      <span class="cb-palette__result-label">${field.label}</span>
                      <span class="cb-palette__result-path">${field.path}</span>
                      ${val !== undefined
                        ? html`<span class="cb-palette__result-value">${typeof val === "string" ? val : JSON.stringify(val)}</span>`
                        : nothing}
                    </div>
                  `;
                })}
          </div>
        </div>
      </div>
    `;
  }

  override render() {
    if (this.state.status === "loading") {
      return html`<div class="cb-screen" style="display:grid;place-items:center;"><div class="card">Loading config builder…</div></div>`;
    }

    if (this.state.status === "error") {
      return html`<div class="cb-screen" style="display:grid;place-items:center;"><pre class="callout danger">${this.state.message}</pre></div>`;
    }

    const { snapshot } = this.state;

    const importDialog = renderImportDialog(
      this.importState,
      Object.keys(this.config).length > 0,
      {
        onReplace: (config) => this.saveConfig(config),
        onMerge: (config) => this.deepMergeConfig(config),
        onClose: () => {
          this.importState = { ...this.importState, open: false };
          this.requestUpdate();
        },
        onStateChange: (next) => {
          this.importState = next;
          this.requestUpdate();
        },
      },
    );

    if (this.mode === "landing") {
      return html`
        <div class="cb-screen">
          ${this.renderTopbar()}
          ${this.renderLanding(snapshot)}
          ${this.renderCommandPalette(snapshot)}
          ${importDialog}
        </div>
      `;
    }

    const workspaceClass = this.mode === "wizard"
      ? "cb-workspace cb-workspace--wizard"
      : "cb-workspace cb-workspace--explorer";
    const previewClass = this.previewCollapsed ? "cb-workspace--preview-collapsed" : "";

    return html`
      <div class="cb-screen">
        ${this.renderTopbar()}
        <div class="${workspaceClass} ${previewClass}">
          ${this.mode === "explorer" ? this.renderExplorer(snapshot) : this.renderWizard()}
          ${this.renderPreview(snapshot)}
        </div>
        ${this.renderCommandPalette(snapshot)}
        ${importDialog}
      </div>
    `;
  }
}

customElements.define("config-builder-app", ConfigBuilderApp);
