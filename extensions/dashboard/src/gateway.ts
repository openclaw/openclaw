import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveBinding, type ResolveBindingOptions } from "./data-read.js";
import {
  isDashboardActor,
  validateWorkspaceDoc,
  type DashboardActor,
  type DashboardBinding,
  type DashboardGrid,
  type DashboardTab,
  type DashboardWidget,
  type JsonValue,
  type WorkspaceDoc,
} from "./schema.js";
import { DashboardStore } from "./store.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;
const TAB_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
const WIDGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const CUSTOM_WIDGET_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];
type GatewayRespond = GatewayMethodContext["respond"];
type GatewayBroadcast = GatewayMethodContext["context"]["broadcast"];

type DashboardGatewayMethodOptions = {
  api: OpenClawPluginApi;
  store?: DashboardStore;
  dataRead?: ResolveBindingOptions;
};

function respondError(respond: GatewayRespond, error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "dashboard_error";
  respond(false, undefined, { code, message: formatErrorMessage(error) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readParams(params: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
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
  description: string,
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

function readOptionalActor(record: Record<string, unknown>): DashboardActor {
  const actor = record.actor ?? "user";
  if (!isDashboardActor(actor)) {
    throw new Error("actor is invalid");
  }
  return actor;
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

function readBooleanPatch(record: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function readGrid(value: unknown, path = "grid"): DashboardGrid {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!["x", "y", "w", "h"].includes(key)) {
      throw new Error(`${path}.${key} is not allowed`);
    }
  }
  return {
    x: readGridInt(value.x, `${path}.x`, 0, 11),
    y: readGridInt(value.y, `${path}.y`, 0, 499),
    w: readGridInt(value.w, `${path}.w`, 1, 12),
    h: readGridInt(value.h, `${path}.h`, 1, 20),
  };
}

function readGridInt(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${path} must be an integer from ${min} to ${max}`);
  }
  return value as number;
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
      .replace(/-+$/g, "") || `w_${randomUUID().replaceAll("-", "").slice(0, 12)}`
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
  if (!isRecord(value)) {
    throw new Error("widget must be an object");
  }
  for (const key of Object.keys(value)) {
    if (
      !["id", "kind", "title", "grid", "collapsed", "hidden", "bindings", "props"].includes(key)
    ) {
      throw new Error(`widget.${key} is not allowed`);
    }
  }
  const title = readOptionalString(value, "title");
  return {
    id: makeUniqueWidgetId(value, doc),
    kind: readRequiredString(value, "kind", "widget.kind"),
    ...(title !== undefined ? { title } : {}),
    grid: readGrid(value.grid, "widget.grid"),
    collapsed: value.collapsed === undefined ? false : readRequiredBoolean(value, "collapsed"),
    hidden: value.hidden === undefined ? false : readRequiredBoolean(value, "hidden"),
    ...(value.bindings !== undefined
      ? { bindings: value.bindings as Record<string, DashboardBinding> }
      : {}),
    ...(value.props !== undefined ? { props: value.props as JsonValue } : {}),
  };
}

function readRequiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function readTabPatch(value: unknown): Partial<Pick<DashboardTab, "title" | "icon" | "hidden">> {
  const patch = readParams(value, ["title", "icon", "hidden"]);
  const title = readOptionalString(patch, "title");
  if (title !== undefined && (title.length < 1 || title.length > 80)) {
    throw new Error("patch.title must be 1-80 characters");
  }
  const icon = readOptionalString(patch, "icon");
  if (icon !== undefined && icon.length > 40) {
    throw new Error("patch.icon must be 40 characters or fewer");
  }
  const hidden = readBooleanPatch(patch, "hidden");
  return {
    ...(title !== undefined ? { title } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(hidden !== undefined ? { hidden } : {}),
  };
}

function readWidgetPatch(value: unknown): Partial<DashboardWidget> {
  const patch = readParams(value, ["title", "grid", "collapsed", "hidden", "bindings", "props"]);
  const title = readOptionalString(patch, "title");
  if (title !== undefined && title.length > 80) {
    throw new Error("patch.title must be 80 characters or fewer");
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(patch.grid !== undefined ? { grid: readGrid(patch.grid, "patch.grid") } : {}),
    ...(readBooleanPatch(patch, "collapsed") !== undefined
      ? { collapsed: readBooleanPatch(patch, "collapsed")! }
      : {}),
    ...(readBooleanPatch(patch, "hidden") !== undefined
      ? { hidden: readBooleanPatch(patch, "hidden")! }
      : {}),
    ...(patch.bindings !== undefined
      ? { bindings: patch.bindings as Record<string, DashboardBinding> }
      : {}),
    ...(patch.props !== undefined ? { props: patch.props as JsonValue } : {}),
  };
}

function readLayout(value: unknown): Array<{ id: string; grid: DashboardGrid }> {
  if (!Array.isArray(value)) {
    throw new Error("layout must be an array");
  }
  return value.map((entry, index) => {
    const record = readParams(entry, ["id", "grid"]);
    return {
      id: readWidgetId(record),
      grid: readGrid(record.grid, `layout[${index}].grid`),
    };
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

function broadcastChange(
  broadcast: GatewayBroadcast,
  params: { doc: WorkspaceDoc; actor: DashboardActor; changedTabSlug?: string },
) {
  broadcast("plugin.dashboard.changed", {
    workspaceVersion: params.doc.workspaceVersion,
    ...(params.changedTabSlug ? { changedTabSlug: params.changedTabSlug } : {}),
    actor: params.actor,
  });
}

async function respondWrite(
  opts: GatewayMethodContext,
  actor: DashboardActor,
  changedTabSlug: string | undefined,
  run: () => Promise<{ doc: WorkspaceDoc }>,
) {
  const result = await run();
  broadcastChange(opts.context.broadcast, { doc: result.doc, actor, changedTabSlug });
  opts.respond(true, { doc: result.doc, workspaceVersion: result.doc.workspaceVersion });
}

export function registerDashboardGatewayMethods(options: DashboardGatewayMethodOptions) {
  const { api } = options;
  const store = options.store ?? new DashboardStore();

  api.registerGatewayMethod(
    "dashboard.workspace.get",
    async ({ respond }) => {
      try {
        const doc = await store.read();
        respond(true, { doc, workspaceVersion: doc.workspaceVersion });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.tab.create",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["slug", "title", "icon", "actor"]);
        const title = readRequiredString(params, "title", "title");
        const actor = readOptionalActor(params);
        const icon = readOptionalString(params, "icon");
        const result = await store.mutate(
          (draft) => {
            const slug =
              params.slug === undefined ? makeUniqueSlug(title, draft.tabs) : readSlug(params);
            if (draft.tabs.some((tab) => tab.slug === slug)) {
              throw new Error(`dashboard tab already exists: ${slug}`);
            }
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
          { actor },
        );
        const changedTabSlug = result.doc.tabs.at(-1)?.slug;
        broadcastChange(opts.context.broadcast, { doc: result.doc, actor, changedTabSlug });
        opts.respond(true, { doc: result.doc, workspaceVersion: result.doc.workspaceVersion });
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.tab.update",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["slug", "patch", "actor"]);
        const slug = readSlug(params);
        const actor = readOptionalActor(params);
        const patch = readTabPatch(params.patch);
        await respondWrite(
          opts,
          actor,
          slug,
          async () =>
            await store.mutate(
              (draft) => {
                Object.assign(findTab(draft, slug), patch);
              },
              { actor },
            ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.tab.delete",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["slug", "actor"]);
        const slug = readSlug(params);
        const actor = readOptionalActor(params);
        await respondWrite(
          opts,
          actor,
          slug,
          async () =>
            await store.mutate(
              (draft) => {
                const nextTabs = draft.tabs.filter((tab) => tab.slug !== slug);
                if (nextTabs.length === draft.tabs.length) {
                  throw new Error(`dashboard tab not found: ${slug}`);
                }
                draft.tabs = nextTabs;
                draft.prefs.tabOrder = draft.prefs.tabOrder.filter((entry) => entry !== slug);
              },
              { actor },
            ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.tab.reorder",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["order", "actor"]);
        const order = readSlugOrder(params.order);
        const actor = readOptionalActor(params);
        await respondWrite(
          opts,
          actor,
          undefined,
          async () =>
            await store.mutate(
              (draft) => {
                const slugs = new Set(draft.tabs.map((tab) => tab.slug));
                for (const slug of order) {
                  if (!slugs.has(slug)) {
                    throw new Error(`dashboard tab not found: ${slug}`);
                  }
                }
                draft.prefs.tabOrder = order;
                appendMissingTabsToOrder(draft);
              },
              { actor },
            ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.widget.add",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "widget", "actor"]);
        const slug = readRequiredString(params, "tab", "tab");
        const actor = readOptionalActor(params);
        await respondWrite(
          opts,
          actor,
          slug,
          async () =>
            await store.mutate(
              (draft) => {
                findTab(draft, slug).widgets.push(readWidgetInput(params.widget, draft));
              },
              { actor },
            ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.widget.update",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "id", "patch", "actor"]);
        const slug = readRequiredString(params, "tab", "tab");
        const id = readWidgetId(params);
        const actor = readOptionalActor(params);
        const patch = readWidgetPatch(params.patch);
        await respondWrite(
          opts,
          actor,
          slug,
          async () =>
            await store.mutate(
              (draft) => {
                Object.assign(findWidget(findTab(draft, slug), id), patch);
              },
              { actor },
            ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.widget.move",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "id", "grid", "toTab", "actor"]);
        if (params.grid !== undefined && params.toTab !== undefined) {
          throw new Error("dashboard.widget.move accepts either grid or toTab, not both");
        }
        const id = readWidgetId(params);
        const actor = readOptionalActor(params);
        const changedTabSlug =
          typeof params.toTab === "string"
            ? params.toTab
            : typeof params.tab === "string"
              ? params.tab
              : undefined;
        await respondWrite(
          opts,
          actor,
          changedTabSlug,
          async () =>
            await store.mutate(
              (draft) => {
                if (params.grid !== undefined) {
                  const slug = readRequiredString(params, "tab", "tab");
                  findWidget(findTab(draft, slug), id).grid = readGrid(params.grid);
                  return;
                }
                const toTab = readRequiredString(params, "toTab", "toTab");
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
              { actor },
            ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.widget.remove",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "id", "actor"]);
        const slug = readRequiredString(params, "tab", "tab");
        const id = readWidgetId(params);
        const actor = readOptionalActor(params);
        await respondWrite(
          opts,
          actor,
          slug,
          async () =>
            await store.mutate(
              (draft) => {
                const tab = findTab(draft, slug);
                const next = tab.widgets.filter((widget) => widget.id !== id);
                if (next.length === tab.widgets.length) {
                  throw new Error(`dashboard widget not found: ${id}`);
                }
                tab.widgets = next;
              },
              { actor },
            ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.widget.setLayout",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "layout", "actor"]);
        const slug = readRequiredString(params, "tab", "tab");
        const layout = readLayout(params.layout);
        const actor = readOptionalActor(params);
        await respondWrite(
          opts,
          actor,
          slug,
          async () =>
            await store.mutate(
              (draft) => {
                const tab = findTab(draft, slug);
                for (const entry of layout) {
                  findWidget(tab, entry.id).grid = entry.grid;
                }
              },
              { actor },
            ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.widget.approve",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["name", "decision", "actor"]);
        const name = readRequiredString(params, "name", "name");
        if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
          throw new Error("name is invalid");
        }
        const decision = readRequiredString(params, "decision", "decision");
        if (decision !== "approved" && decision !== "rejected") {
          throw new Error("decision must be approved or rejected");
        }
        const actor = readOptionalActor(params);
        await respondWrite(
          opts,
          actor,
          undefined,
          async () =>
            await store.mutate(
              (draft) => {
                const existing = draft.widgetsRegistry[name];
                draft.widgetsRegistry[name] = {
                  status: decision,
                  createdBy: existing?.createdBy ?? actor,
                  ...(decision === "approved"
                    ? { approvedBy: actor, approvedAt: new Date().toISOString() }
                    : {}),
                };
              },
              { actor },
            ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.workspace.replace",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["doc", "actor"]);
        const actor = readOptionalActor(params);
        const doc = validateWorkspaceDoc(params.doc);
        // `replaceSanitized`, not `replace`: an untrusted whole-document write must
        // not be able to elevate a custom widget to `approved` (approve is the sole
        // transition to that state). See DashboardStore.replaceSanitized.
        await respondWrite(
          opts,
          actor,
          undefined,
          async () => await store.replaceSanitized(doc, { actor }),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.workspace.undo",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["actor"]);
        const actor = readOptionalActor(params);
        const doc = await store.undo();
        broadcastChange(opts.context.broadcast, { doc, actor });
        opts.respond(true, { doc, workspaceVersion: doc.workspaceVersion });
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "dashboard.data.read",
    async ({ params: requestParams, respond }) => {
      try {
        const params = readParams(requestParams, ["binding"]);
        respond(true, {
          data: await resolveBinding(params.binding, options.dataRead),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );
}

function readSlugOrder(value: unknown): string[] {
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
