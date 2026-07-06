import fs from "node:fs/promises";
import path from "node:path";
import { jsonResult } from "openclaw/plugin-sdk/core";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { Type } from "typebox";
import { resolveBinding, type ResolveBindingOptions } from "./data-read.js";
import {
  isDashboardActor,
  validateWorkspaceDoc,
  type DashboardActor,
  type DashboardBinding,
  type DashboardGrid,
  type DashboardTab,
  type DashboardWidget,
  type DashboardWidgetRegistryEntry,
  type JsonValue,
  type WorkspaceDoc,
} from "./schema.js";
import { DashboardStore } from "./store.js";

export type DashboardBroadcast = (event: string, payload: unknown) => void;

type DashboardToolParams = {
  api: OpenClawPluginApi;
  context?: OpenClawPluginToolContext;
  store?: DashboardStore;
  broadcast?: DashboardBroadcast;
  dataRead?: ResolveBindingOptions;
};

type MutationParams = {
  store: DashboardStore;
  actor: DashboardActor;
  broadcast?: DashboardBroadcast;
  changedTabSlug?: string;
  mutate: (draft: WorkspaceDoc) => void | WorkspaceDoc | Promise<void | WorkspaceDoc>;
};

export type DashboardScaffoldOptions = {
  name: string;
  title?: string;
  stateDir?: string;
  /** Provenance stamped into the scaffold's "built by" footer. */
  createdBy?: string;
};

export type DashboardScaffoldResult = {
  name: string;
  title: string;
  dir: string;
  manifestPath: string;
  htmlPath: string;
  readmePath: string;
};

const TAB_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
const WIDGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const CUSTOM_WIDGET_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const TOOL_DESCRIPTION_SUFFIX =
  " Call dashboard_workspace_get first when you need the current document.";

const JsonSchema = Type.Unknown({ description: "JSON-compatible value." });
const GridSchema = Type.Object(
  {
    x: Type.Integer({ minimum: 0, maximum: 11, description: "Grid x column, 0-11." }),
    y: Type.Integer({ minimum: 0, maximum: 499, description: "Grid row, 0-499." }),
    w: Type.Integer({ minimum: 1, maximum: 12, description: "Grid width, 1-12." }),
    h: Type.Integer({ minimum: 1, maximum: 20, description: "Grid height, 1-20." }),
  },
  { additionalProperties: false },
);
const BindingSchema = Type.Union([
  Type.Object(
    {
      source: Type.Literal("rpc"),
      method: Type.String({ description: "Allowlisted gateway read method." }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("file"),
      path: Type.String({ description: "Relative path under dashboard/data." }),
      pointer: Type.Optional(Type.String({ description: "Optional JSON pointer." })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("static"),
      value: JsonSchema,
    },
    { additionalProperties: false },
  ),
]);
const BindingsRecordSchema = Type.Record(Type.String(), BindingSchema, {
  description: "Widget binding map keyed by binding id.",
});
const WidgetPatchSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ description: "Widget title, 80 chars max." })),
    grid: Type.Optional(GridSchema),
    collapsed: Type.Optional(Type.Boolean({ description: "Collapse widget body." })),
    hidden: Type.Optional(Type.Boolean({ description: "Hide widget." })),
    bindings: Type.Optional(BindingsRecordSchema),
    props: Type.Optional(JsonSchema),
  },
  { additionalProperties: false },
);
const WidgetInputSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ description: "Optional unique widget id." })),
    kind: Type.String({ description: "builtin:<name> or custom:<name>." }),
    title: Type.Optional(Type.String({ description: "Widget title." })),
    grid: GridSchema,
    collapsed: Type.Optional(Type.Boolean({ description: "Initial collapsed state." })),
    hidden: Type.Optional(Type.Boolean({ description: "Initial hidden state." })),
    bindings: Type.Optional(BindingsRecordSchema),
    props: Type.Optional(JsonSchema),
  },
  { additionalProperties: false },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(params: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!isRecord(params)) {
    throw new Error("params must be an object");
  }
  for (const key of Object.keys(params)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`unexpected param: ${key}`);
    }
  }
  return params;
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  description = key,
): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${description} is required`);
  }
  return value.trim();
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value.trim();
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function readSlug(record: Record<string, unknown>, key = "slug"): string {
  const slug = readRequiredString(record, key, key);
  if (!TAB_SLUG_PATTERN.test(slug)) {
    throw new Error(`${key} is invalid`);
  }
  return slug;
}

function readWidgetId(record: Record<string, unknown>, key = "id"): string {
  const id = readRequiredString(record, key, key);
  if (!WIDGET_ID_PATTERN.test(id)) {
    throw new Error(`${key} is invalid`);
  }
  return id;
}

function readGrid(value: unknown, pathName = "grid"): DashboardGrid {
  if (!isRecord(value)) {
    throw new Error(`${pathName} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!["x", "y", "w", "h"].includes(key)) {
      throw new Error(`${pathName}.${key} is not allowed`);
    }
  }
  return {
    x: readGridInt(value.x, `${pathName}.x`, 0, 11),
    y: readGridInt(value.y, `${pathName}.y`, 0, 499),
    w: readGridInt(value.w, `${pathName}.w`, 1, 12),
    h: readGridInt(value.h, `${pathName}.h`, 1, 20),
  };
}

function readGridInt(value: unknown, pathName: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${pathName} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function readBindings(value: unknown): Record<string, DashboardBinding> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("bindings must be an object");
  }
  return value as Record<string, DashboardBinding>;
}

function slugBase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function makeUniqueSlug(title: string, tabs: DashboardTab[]): string {
  const used = new Set(tabs.map((tab) => tab.slug));
  const base = slugBase(title) || "tab";
  if (!used.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("could not generate a unique tab slug");
}

function makeWidgetIdBase(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "widget"
  );
}

function makeUniqueWidgetId(widget: Record<string, unknown>, doc: WorkspaceDoc): string {
  const existing = new Set(doc.tabs.flatMap((tab) => tab.widgets.map((entry) => entry.id)));
  const explicit = widget.id;
  if (explicit !== undefined) {
    if (typeof explicit !== "string" || !WIDGET_ID_PATTERN.test(explicit)) {
      throw new Error("widget.id is invalid");
    }
    if (existing.has(explicit)) {
      throw new Error(`duplicate widget id: ${explicit}`);
    }
    return explicit;
  }
  const title =
    typeof widget.title === "string"
      ? widget.title
      : typeof widget.kind === "string"
        ? widget.kind
        : "widget";
  const base = makeWidgetIdBase(title);
  if (!existing.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("could not generate a unique widget id");
}

function findTab(doc: WorkspaceDoc, slug: string): DashboardTab {
  const tab = doc.tabs.find((entry) => entry.slug === slug);
  if (!tab) {
    throw new Error(`dashboard tab not found: ${slug}`);
  }
  return tab;
}

function findWidget(tab: DashboardTab, id: string): DashboardWidget {
  const widget = tab.widgets.find((entry) => entry.id === id);
  if (!widget) {
    throw new Error(`dashboard widget not found: ${id}`);
  }
  return widget;
}

function readWidgetInput(value: unknown, doc: WorkspaceDoc): DashboardWidget {
  const record = readRecord(value, [
    "id",
    "kind",
    "title",
    "grid",
    "collapsed",
    "hidden",
    "bindings",
    "props",
  ]);
  const title = readOptionalString(record, "title");
  const bindings = readBindings(record.bindings);
  return {
    id: makeUniqueWidgetId(record, doc),
    kind: readRequiredString(record, "kind", "kind"),
    ...(title !== undefined ? { title } : {}),
    grid: readGrid(record.grid),
    collapsed: readOptionalBoolean(record, "collapsed") ?? false,
    hidden: readOptionalBoolean(record, "hidden") ?? false,
    ...(bindings !== undefined ? { bindings } : {}),
    ...(record.props !== undefined ? { props: record.props as JsonValue } : {}),
  };
}

function readWidgetPatch(value: unknown): Partial<DashboardWidget> {
  const record = readRecord(value, ["title", "grid", "collapsed", "hidden", "bindings", "props"]);
  const title = readOptionalString(record, "title");
  const collapsed = readOptionalBoolean(record, "collapsed");
  const hidden = readOptionalBoolean(record, "hidden");
  const bindings = readBindings(record.bindings);
  return {
    ...(title !== undefined ? { title } : {}),
    ...(record.grid !== undefined ? { grid: readGrid(record.grid) } : {}),
    ...(collapsed !== undefined ? { collapsed } : {}),
    ...(hidden !== undefined ? { hidden } : {}),
    ...(bindings !== undefined ? { bindings } : {}),
    ...(record.props !== undefined ? { props: record.props as JsonValue } : {}),
  };
}

function readLayout(value: unknown): Array<{ id: string; grid: DashboardGrid }> {
  if (!Array.isArray(value)) {
    throw new Error("layout must be an array");
  }
  return value.map((entry, index) => {
    const record = readRecord(entry, ["id", "grid"]);
    return {
      id: readWidgetId(record),
      grid: readGrid(record.grid, `layout[${index}].grid`),
    };
  });
}

function readOrder(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("order must be an array");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !TAB_SLUG_PATTERN.test(entry)) {
      throw new Error(`order[${index}] is invalid`);
    }
    if (seen.has(entry)) {
      throw new Error(`order contains duplicate slug: ${entry}`);
    }
    seen.add(entry);
    return entry;
  });
}

function appendMissingTabsToOrder(doc: WorkspaceDoc): void {
  const seen = new Set(doc.prefs.tabOrder);
  for (const tab of doc.tabs) {
    if (!seen.has(tab.slug)) {
      doc.prefs.tabOrder.push(tab.slug);
    }
  }
}

function contextOwner(ctx: OpenClawPluginToolContext | undefined): string {
  const record = (ctx ?? {}) as Record<string, unknown>;
  return (
    (typeof record.agentId === "string" && record.agentId) ||
    (typeof record.sessionKey === "string" && record.sessionKey) ||
    (typeof record.sessionId === "string" && record.sessionId) ||
    "agent"
  );
}

function actorFromContext(ctx: OpenClawPluginToolContext | undefined): DashboardActor {
  const normalized =
    contextOwner(ctx)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "agent";
  const actor = `agent:${normalized}`;
  if (!isDashboardActor(actor)) {
    throw new Error("tool context owner cannot be used as dashboard actor");
  }
  return actor;
}

function sanitizeAgentWorkspaceReplace(params: {
  doc: WorkspaceDoc;
  current: WorkspaceDoc;
  actor: DashboardActor;
}): WorkspaceDoc {
  const existingTabs = new Map(params.current.tabs.map((tab) => [tab.slug, tab]));
  const widgetsRegistry: Record<string, DashboardWidgetRegistryEntry> = {};
  for (const name of Object.keys(params.doc.widgetsRegistry)) {
    widgetsRegistry[name] = params.current.widgetsRegistry[name] ?? {
      status: "pending",
      createdBy: params.actor,
    };
  }
  return {
    ...params.doc,
    tabs: params.doc.tabs.map((tab) => ({
      ...tab,
      createdBy: existingTabs.get(tab.slug)?.createdBy ?? params.actor,
    })),
    widgetsRegistry,
  };
}

function broadcastChange(
  broadcast: DashboardBroadcast | undefined,
  params: { doc: WorkspaceDoc; actor: DashboardActor; changedTabSlug?: string },
) {
  broadcast?.("plugin.dashboard.changed", {
    workspaceVersion: params.doc.workspaceVersion,
    ...(params.changedTabSlug ? { changedTabSlug: params.changedTabSlug } : {}),
    actor: params.actor,
  });
}

function resolveDashboardBroadcast(
  broadcast: DashboardBroadcast | undefined,
): DashboardBroadcast | undefined {
  return broadcast ?? getPluginRuntimeGatewayRequestScope()?.context?.broadcast;
}

async function runMutation(params: MutationParams) {
  const result = await params.store.mutate(params.mutate, { actor: params.actor });
  broadcastChange(params.broadcast, {
    doc: result.doc,
    actor: params.actor,
    changedTabSlug: params.changedTabSlug,
  });
  return jsonResult({ doc: result.doc, workspaceVersion: result.doc.workspaceVersion });
}

function scaffoldTitle(name: string, title: string | undefined): string {
  if (title?.trim()) {
    return title.trim();
  }
  return name
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function widgetManifest(name: string, title: string) {
  return {
    schemaVersion: 1,
    name,
    title,
    entrypoint: "index.html",
    bindings: [{ id: "value", source: "static", value: "Hello from your dashboard widget." }],
    capabilities: ["data:read"],
    preferredSize: { w: 6, h: 4 },
  };
}

// Scaffold template (spec-50 §Scaffold): demonstrates the v1 handshake, getData +
// onData(=push), theme tokens applied to CSS vars, ZERO external requests, and a
// visible "built by <createdBy>" footer. Framework-free and < 100 lines.
function widgetHtml(title: string, createdBy: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; --wg-bg: Canvas; --wg-text: CanvasText; --wg-accent: #ff5c5c; }
    body { margin: 0; padding: 16px; font-family: var(--font-sans, system-ui, sans-serif);
      background: var(--wg-bg); color: var(--wg-text); }
    h1 { margin: 0 0 12px; font-size: 1.1rem; }
    #value { white-space: pre-wrap; overflow-wrap: anywhere; }
    footer { margin-top: 16px; font-size: 0.75rem; color: var(--wg-accent); }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <pre id="value">Waiting for dashboard data...</pre>
  <footer>Built by ${escapeHtml(createdBy)}</footer>
  <script>
    const valueNode = document.getElementById("value");
    function post(type, payload = {}) {
      window.parent.postMessage({ v: 1, type, ...payload }, "*");
    }
    function render(data) {
      valueNode.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }
    function onData(message) {
      render(message.data);
    }
    function applyTheme(tokens) {
      const root = document.documentElement.style;
      if (tokens["--bg"]) root.setProperty("--wg-bg", tokens["--bg"]);
      if (tokens["--text"]) root.setProperty("--wg-text", tokens["--text"]);
      if (tokens["--accent"]) root.setProperty("--wg-accent", tokens["--accent"]);
    }
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.v !== 1) return;
      if (message.type === "dashboard:data" || message.type === "dashboard:push") onData(message);
      else if (message.type === "dashboard:theme") applyTheme(message.tokens || {});
      else if (message.type === "dashboard:error") render({ error: message.message });
    });
    post("dashboard:ready");
    post("dashboard:getData", { requestId: "initial", bindingId: "value" });
    post("dashboard:getTheme", { requestId: "theme" });
  </script>
</body>
</html>
`;
}

function widgetReadme(name: string): string {
  return `# ${name}

This dashboard widget runs inside a sandboxed iframe and talks to the parent
Control UI through the dashboard message bridge.

- Send \`{ "v": 1, "type": "dashboard:ready" }\` when loaded.
- Send \`dashboard:getData\` with a \`requestId\` and \`bindingId\` to read a declared binding.
- Re-render on \`dashboard:data\` and \`dashboard:push\`.
- Do not fetch gateway data directly; the authenticated parent resolves bindings.
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function scaffoldDashboardWidget(
  options: DashboardScaffoldOptions,
): Promise<DashboardScaffoldResult> {
  const name = options.name.trim();
  if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
    throw new Error("widget name is invalid");
  }
  const title = scaffoldTitle(name, options.title);
  const widgetsRoot = path.resolve(options.stateDir ?? resolveStateDir(), "dashboard", "widgets");
  const widgetDir = path.resolve(widgetsRoot, name);
  if (widgetDir === widgetsRoot || !widgetDir.startsWith(`${widgetsRoot}${path.sep}`)) {
    throw new Error("widget name is invalid");
  }
  await fs.mkdir(widgetsRoot, { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(widgetDir, { mode: 0o700 });
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      throw new Error("widget already exists", { cause: error });
    }
    throw error;
  }
  const manifestPath = path.join(widgetDir, "widget.json");
  const htmlPath = path.join(widgetDir, "index.html");
  const readmePath = path.join(widgetDir, "README.md");
  await Promise.all([
    fs.writeFile(
      `${manifestPath}.tmp`,
      `${JSON.stringify(widgetManifest(name, title), null, 2)}\n`,
      {
        mode: 0o600,
      },
    ),
    fs.writeFile(`${htmlPath}.tmp`, widgetHtml(title, options.createdBy ?? "an agent"), {
      mode: 0o600,
    }),
    fs.writeFile(`${readmePath}.tmp`, widgetReadme(name), { mode: 0o600 }),
  ]);
  await Promise.all([
    fs.rename(`${manifestPath}.tmp`, manifestPath),
    fs.rename(`${htmlPath}.tmp`, htmlPath),
    fs.rename(`${readmePath}.tmp`, readmePath),
  ]);
  return { name, title, dir: widgetDir, manifestPath, htmlPath, readmePath };
}

function toolDescription(text: string): string {
  return `${text}${TOOL_DESCRIPTION_SUFFIX}`;
}

export function createDashboardTools(params: DashboardToolParams): AnyAgentTool[] {
  const store = params.store ?? new DashboardStore();
  const actor = actorFromContext(params.context);
  const broadcast = resolveDashboardBroadcast(params.broadcast);
  const mutationBase = {
    store,
    actor,
    broadcast,
  };
  return [
    {
      name: "dashboard_workspace_get",
      label: "Dashboard Workspace Get",
      description:
        "Read the full dashboard workspace document so an agent can diff before mutating it.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const doc = await store.read();
        return jsonResult({ doc, workspaceVersion: doc.workspaceVersion });
      },
    },
    {
      name: "dashboard_tab_create",
      label: "Dashboard Tab Create",
      description: toolDescription(
        "Create a dashboard tab. Slugs are lowercase letters, digits, and dashes, max 40 chars.",
      ),
      parameters: Type.Object(
        {
          title: Type.String({ description: "Tab title, 1-80 chars." }),
          slug: Type.Optional(Type.String({ description: "Optional tab slug." })),
          icon: Type.Optional(Type.String({ description: "Optional icon name." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["title", "slug", "icon"]);
        const title = readRequiredString(record, "title", "title");
        const icon = readOptionalString(record, "icon");
        let changedTabSlug: string | undefined;
        return await runMutation({
          ...mutationBase,
          mutate: (draft) => {
            const slug =
              record.slug === undefined ? makeUniqueSlug(title, draft.tabs) : readSlug(record);
            if (draft.tabs.some((tab) => tab.slug === slug)) {
              throw new Error(`dashboard tab already exists: ${slug}`);
            }
            changedTabSlug = slug;
            draft.tabs.push({
              slug,
              title,
              ...(icon !== undefined ? { icon } : {}),
              hidden: false,
              createdBy: actor,
              widgets: [],
            });
            draft.prefs.tabOrder.push(slug);
          },
          get changedTabSlug() {
            return changedTabSlug;
          },
        });
      },
    },
    {
      name: "dashboard_tab_update",
      label: "Dashboard Tab Update",
      description: toolDescription("Update a dashboard tab title, icon, or hidden state."),
      parameters: Type.Object(
        {
          slug: Type.String({ description: "Tab slug." }),
          title: Type.Optional(Type.String({ description: "New title." })),
          icon: Type.Optional(Type.String({ description: "New icon." })),
          hidden: Type.Optional(Type.Boolean({ description: "Hide or show the tab." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["slug", "title", "icon", "hidden"]);
        const slug = readSlug(record);
        const title = readOptionalString(record, "title");
        const icon = readOptionalString(record, "icon");
        const hidden = readOptionalBoolean(record, "hidden");
        return await runMutation({
          ...mutationBase,
          changedTabSlug: slug,
          mutate: (draft) => {
            Object.assign(findTab(draft, slug), {
              ...(title !== undefined ? { title } : {}),
              ...(icon !== undefined ? { icon } : {}),
              ...(hidden !== undefined ? { hidden } : {}),
            });
          },
        });
      },
    },
    {
      name: "dashboard_tab_delete",
      label: "Dashboard Tab Delete",
      description: toolDescription("Delete a dashboard tab and all widgets inside it."),
      parameters: Type.Object(
        { slug: Type.String({ description: "Tab slug." }) },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["slug"]);
        const slug = readSlug(record);
        return await runMutation({
          ...mutationBase,
          changedTabSlug: slug,
          mutate: (draft) => {
            const nextTabs = draft.tabs.filter((tab) => tab.slug !== slug);
            if (nextTabs.length === draft.tabs.length) {
              throw new Error(`dashboard tab not found: ${slug}`);
            }
            draft.tabs = nextTabs;
            draft.prefs.tabOrder = draft.prefs.tabOrder.filter((entry) => entry !== slug);
          },
        });
      },
    },
    {
      name: "dashboard_tabs_reorder",
      label: "Dashboard Tabs Reorder",
      description: toolDescription("Set dashboard tab order. Missing existing tabs are appended."),
      parameters: Type.Object(
        { order: Type.Array(Type.String({ description: "Tab slug." })) },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["order"]);
        const order = readOrder(record.order);
        return await runMutation({
          ...mutationBase,
          mutate: (draft) => {
            const slugs = new Set(draft.tabs.map((tab) => tab.slug));
            for (const slug of order) {
              if (!slugs.has(slug)) {
                throw new Error(`dashboard tab not found: ${slug}`);
              }
            }
            draft.prefs.tabOrder = order;
            appendMissingTabsToOrder(draft);
          },
        });
      },
    },
    {
      name: "dashboard_widget_add",
      label: "Dashboard Widget Add",
      description: toolDescription(
        "Add a widget to a tab. Grid x+w must fit within the 12-column dashboard grid.",
      ),
      parameters: Type.Object(
        {
          tab: Type.String({ description: "Target tab slug." }),
          ...WidgetInputSchema.properties,
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, [
          "tab",
          "id",
          "kind",
          "title",
          "grid",
          "collapsed",
          "hidden",
          "bindings",
          "props",
        ]);
        const tabSlug = readSlug(record, "tab");
        const widgetInput = { ...record };
        delete widgetInput.tab;
        return await runMutation({
          ...mutationBase,
          changedTabSlug: tabSlug,
          mutate: (draft) => {
            findTab(draft, tabSlug).widgets.push(readWidgetInput(widgetInput, draft));
          },
        });
      },
    },
    {
      name: "dashboard_widget_update",
      label: "Dashboard Widget Update",
      description: toolDescription("Patch a widget title, grid, visibility, bindings, or props."),
      parameters: Type.Object(
        {
          tab: Type.String({ description: "Tab slug." }),
          id: Type.String({ description: "Widget id." }),
          ...WidgetPatchSchema.properties,
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, [
          "tab",
          "id",
          "title",
          "grid",
          "collapsed",
          "hidden",
          "bindings",
          "props",
        ]);
        const tabSlug = readSlug(record, "tab");
        const id = readWidgetId(record);
        const patch = readWidgetPatch(record);
        return await runMutation({
          ...mutationBase,
          changedTabSlug: tabSlug,
          mutate: (draft) => {
            Object.assign(findWidget(findTab(draft, tabSlug), id), patch);
          },
        });
      },
    },
    {
      name: "dashboard_widget_move",
      label: "Dashboard Widget Move",
      description: toolDescription(
        "Move a widget by changing its grid or moving it to another tab.",
      ),
      parameters: Type.Object(
        {
          tab: Type.Optional(Type.String({ description: "Current tab slug for grid moves." })),
          id: Type.String({ description: "Widget id." }),
          grid: Type.Optional(GridSchema),
          toTab: Type.Optional(Type.String({ description: "Destination tab slug." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["tab", "id", "grid", "toTab"]);
        if (record.grid !== undefined && record.toTab !== undefined) {
          throw new Error("dashboard_widget_move accepts either grid or toTab, not both");
        }
        if (record.grid === undefined && record.toTab === undefined) {
          throw new Error("dashboard_widget_move requires grid or toTab");
        }
        const id = readWidgetId(record);
        const changedTabSlug =
          typeof record.toTab === "string"
            ? record.toTab
            : typeof record.tab === "string"
              ? record.tab
              : undefined;
        return await runMutation({
          ...mutationBase,
          changedTabSlug,
          mutate: (draft) => {
            if (record.grid !== undefined) {
              const tabSlug = readSlug(record, "tab");
              findWidget(findTab(draft, tabSlug), id).grid = readGrid(record.grid);
              return;
            }
            const toTab = readSlug(record, "toTab");
            const destination = findTab(draft, toTab);
            for (const tab of draft.tabs) {
              const index = tab.widgets.findIndex((widget) => widget.id === id);
              if (index >= 0) {
                destination.widgets.push(tab.widgets.splice(index, 1)[0]!);
                return;
              }
            }
            throw new Error(`dashboard widget not found: ${id}`);
          },
        });
      },
    },
    {
      name: "dashboard_widget_remove",
      label: "Dashboard Widget Remove",
      description: toolDescription("Remove a widget from a tab."),
      parameters: Type.Object(
        {
          tab: Type.String({ description: "Tab slug." }),
          id: Type.String({ description: "Widget id." }),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["tab", "id"]);
        const tabSlug = readSlug(record, "tab");
        const id = readWidgetId(record);
        return await runMutation({
          ...mutationBase,
          changedTabSlug: tabSlug,
          mutate: (draft) => {
            const tab = findTab(draft, tabSlug);
            const next = tab.widgets.filter((widget) => widget.id !== id);
            if (next.length === tab.widgets.length) {
              throw new Error(`dashboard widget not found: ${id}`);
            }
            tab.widgets = next;
          },
        });
      },
    },
    {
      name: "dashboard_layout_set",
      label: "Dashboard Layout Set",
      description: toolDescription("Batch-update widget grids for one tab."),
      parameters: Type.Object(
        {
          tab: Type.String({ description: "Tab slug." }),
          layout: Type.Array(
            Type.Object(
              { id: Type.String({ description: "Widget id." }), grid: GridSchema },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["tab", "layout"]);
        const tabSlug = readSlug(record, "tab");
        const layout = readLayout(record.layout);
        return await runMutation({
          ...mutationBase,
          changedTabSlug: tabSlug,
          mutate: (draft) => {
            const tab = findTab(draft, tabSlug);
            for (const entry of layout) {
              findWidget(tab, entry.id).grid = entry.grid;
            }
          },
        });
      },
    },
    {
      name: "dashboard_workspace_replace",
      label: "Dashboard Workspace Replace",
      description: toolDescription(
        "Replace the full workspace document after local validation and size/schema caps.",
      ),
      parameters: Type.Object({ doc: Type.Unknown() }, { additionalProperties: false }),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["doc"]);
        const doc = validateWorkspaceDoc(record.doc);
        const result = await store.mutate(
          (current) => sanitizeAgentWorkspaceReplace({ doc, current, actor }),
          { actor },
        );
        broadcastChange(broadcast, { doc: result.doc, actor });
        return jsonResult({ doc: result.doc, workspaceVersion: result.doc.workspaceVersion });
      },
    },
    {
      name: "dashboard_widget_scaffold",
      label: "Dashboard Widget Scaffold",
      description: toolDescription(
        "Create a custom widget scaffold. Agent-authored scaffolds enter the registry as pending.",
      ),
      parameters: Type.Object(
        {
          name: Type.String({ description: "Custom widget name, A-Z a-z 0-9 . _ - only." }),
          title: Type.Optional(Type.String({ description: "Widget display title." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["name", "title"]);
        const scaffold = await scaffoldDashboardWidget({
          name: readRequiredString(record, "name", "name"),
          title: readOptionalString(record, "title"),
          stateDir: store.stateDir,
          createdBy: actor,
        });
        const result = await store.mutate(
          (draft) => {
            draft.widgetsRegistry[scaffold.name] = {
              status: "pending",
              createdBy: actor,
            };
          },
          { actor },
        );
        broadcastChange(broadcast, { doc: result.doc, actor });
        return jsonResult({
          ...scaffold,
          registry: result.doc.widgetsRegistry[scaffold.name],
          workspaceVersion: result.doc.workspaceVersion,
        });
      },
    },
    {
      name: "dashboard_undo",
      label: "Dashboard Undo",
      description: "Restore the newest dashboard undo snapshot.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const doc = await store.undo();
        broadcastChange(broadcast, { doc, actor });
        return jsonResult({ doc, workspaceVersion: doc.workspaceVersion });
      },
    },
    {
      name: "dashboard_data_read",
      label: "Dashboard Data Read",
      description:
        "Resolve a dashboard binding exactly as a widget sees it. RPC bindings return binding_client_resolved.",
      parameters: Type.Object({ binding: BindingSchema }, { additionalProperties: false }),
      execute: async (_toolCallId, rawParams) => {
        const record = readRecord(rawParams, ["binding"]);
        return jsonResult({ data: await resolveBinding(record.binding, params.dataRead) });
      },
    },
  ];
}
