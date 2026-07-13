import { randomUUID } from "node:crypto";
import {
  BUILTIN_WIDGET_KINDS,
  validateWorkspaceDoc,
  type WorkspaceDoc,
  type WorkspaceGrid,
  type WorkspaceTab,
  type WorkspaceWidget,
  type WorkspaceWidgetRegistryEntry,
} from "./schema.js";

export const MAX_WORKSPACE_IMPORT_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 64;
const DISTRIBUTION_FORMAT = "openclaw-workspaces";
const DISTRIBUTION_VERSION = 1;
const TAB_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
const CUSTOM_KIND_PATTERN = /^custom:(?!__proto__$)[A-Za-z0-9._-]{1,64}$/;

type WorkspaceDistributionWidget = {
  kind: string;
  title?: string;
  grid: WorkspaceGrid;
  collapsed: boolean;
  hidden: boolean;
};

type WorkspaceDistributionTab = {
  slug: string;
  title: string;
  icon?: string;
  hidden: boolean;
  widgets: WorkspaceDistributionWidget[];
};

export type WorkspaceDistribution = {
  format: typeof DISTRIBUTION_FORMAT;
  version: typeof DISTRIBUTION_VERSION;
  tabs: WorkspaceDistributionTab[];
};

export type PreparedWorkspaceImport = {
  baseWorkspaceVersion: number;
  tabs: WorkspaceTab[];
  registry: Record<string, WorkspaceWidgetRegistryEntry>;
  summary: { tabs: number; widgets: number; customWidgets: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${path}.${key} is not allowed`);
    }
  }
}

function requireString(value: Record<string, unknown>, key: string, path: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`${path}.${key} must be a string`);
  }
  return field;
}

function requireBoolean(value: Record<string, unknown>, key: string, path: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw new Error(`${path}.${key} must be a boolean`);
  }
  return field;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== "string") {
    throw new Error(`${path}.${key} must be a string`);
  }
  return field;
}

function assertSafeJsonStructure(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > MAX_JSON_DEPTH) {
      throw new Error(`import JSON must be no more than ${MAX_JSON_DEPTH} levels deep`);
    }
    if (Array.isArray(current.value)) {
      for (const entry of current.value) {
        stack.push({ value: entry, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(current.value)) {
      continue;
    }
    for (const [key, entry] of Object.entries(current.value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error(`import JSON contains unsafe key: ${key}`);
      }
      stack.push({ value: entry, depth: current.depth + 1 });
    }
  }
}

function distributionWidget(widget: WorkspaceWidget): WorkspaceDistributionWidget {
  return {
    kind: widget.kind,
    ...(widget.title !== undefined ? { title: widget.title } : {}),
    grid: structuredClone(widget.grid),
    collapsed: widget.collapsed,
    hidden: widget.hidden,
  };
}

function distributionTab(tab: WorkspaceTab): WorkspaceDistributionTab {
  return {
    slug: tab.slug,
    title: tab.title,
    ...(tab.icon !== undefined ? { icon: tab.icon } : {}),
    hidden: tab.hidden,
    widgets: tab.widgets.map(distributionWidget),
  };
}

export function buildWorkspaceDistribution(
  doc: WorkspaceDoc,
  options: { tabIds?: readonly string[] } = {},
): WorkspaceDistribution {
  const tabIds = options.tabIds;
  let tabs = doc.tabs;
  if (tabIds && tabIds.length > 0) {
    const requested = new Set(tabIds);
    tabs = doc.tabs.filter((tab) => requested.has(tab.id));
    for (const id of requested) {
      if (!tabs.some((tab) => tab.id === id)) {
        throw new Error(`workspace tab not found: ${id}`);
      }
    }
  }
  const preferredOrder = new Map(doc.prefs.tabOrder.map((slug, index) => [slug, index]));
  tabs = tabs.toSorted((left, right) => {
    const leftIndex = preferredOrder.get(left.slug);
    const rightIndex = preferredOrder.get(right.slug);
    if (leftIndex === undefined) {
      return rightIndex === undefined ? 0 : 1;
    }
    return rightIndex === undefined ? -1 : leftIndex - rightIndex;
  });
  return {
    format: DISTRIBUTION_FORMAT,
    version: DISTRIBUTION_VERSION,
    tabs: tabs.map(distributionTab),
  };
}

export function serializeWorkspaceDistribution(
  doc: WorkspaceDoc,
  options: { tabIds?: readonly string[] } = {},
): string {
  const serialized = `${JSON.stringify(buildWorkspaceDistribution(doc, options), null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKSPACE_IMPORT_BYTES) {
    throw new Error("workspace export must serialize to 256 KB or less");
  }
  return serialized;
}

function readGrid(value: unknown, path: string): WorkspaceGrid {
  const grid = assertRecord(value, path);
  assertKnownKeys(grid, ["x", "y", "w", "h"], path);
  return {
    x: grid.x as number,
    y: grid.y as number,
    w: grid.w as number,
    h: grid.h as number,
  };
}

function readDistributionWidget(value: unknown, path: string): WorkspaceDistributionWidget {
  const widget = assertRecord(value, path);
  assertKnownKeys(widget, ["kind", "title", "grid", "collapsed", "hidden"], path);
  const title = optionalString(widget, "title", path);
  return {
    kind: requireString(widget, "kind", path),
    ...(title !== undefined ? { title } : {}),
    grid: readGrid(widget.grid, `${path}.grid`),
    collapsed: requireBoolean(widget, "collapsed", path),
    hidden: requireBoolean(widget, "hidden", path),
  };
}

function readDistributionTab(value: unknown, path: string): WorkspaceDistributionTab {
  const tab = assertRecord(value, path);
  assertKnownKeys(tab, ["slug", "title", "icon", "hidden", "widgets"], path);
  const widgets = tab.widgets;
  if (!Array.isArray(widgets)) {
    throw new Error(`${path}.widgets must be an array`);
  }
  if (widgets.length > 24) {
    throw new Error(`${path}.widgets must contain at most 24 entries`);
  }
  const icon = optionalString(tab, "icon", path);
  return {
    slug: requireString(tab, "slug", path),
    title: requireString(tab, "title", path),
    ...(icon !== undefined ? { icon } : {}),
    hidden: requireBoolean(tab, "hidden", path),
    widgets: widgets.map((widget, index) =>
      readDistributionWidget(widget, `${path}.widgets[${index}]`),
    ),
  };
}

export function parseWorkspaceDistribution(text: string): WorkspaceDistribution {
  if (Buffer.byteLength(text, "utf8") > MAX_WORKSPACE_IMPORT_BYTES) {
    throw new Error("workspace import must be 256 KB or less");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("workspace import is not valid JSON");
  }
  assertSafeJsonStructure(parsed);
  const root = assertRecord(parsed, "workspace import");
  assertKnownKeys(root, ["format", "version", "tabs"], "workspace import");
  if (root.format !== DISTRIBUTION_FORMAT || root.version !== DISTRIBUTION_VERSION) {
    throw new Error("workspace import format or version is unsupported");
  }
  if (!Array.isArray(root.tabs)) {
    throw new Error("workspace import.tabs must be an array");
  }
  if (root.tabs.length === 0 || root.tabs.length > 32) {
    throw new Error("workspace import.tabs must contain 1-32 entries");
  }
  return {
    format: DISTRIBUTION_FORMAT,
    version: DISTRIBUTION_VERSION,
    tabs: root.tabs.map((tab, index) => readDistributionTab(tab, `tabs[${index}]`)),
  };
}

function uniqueSlug(base: string, used: Set<string>): string {
  if (!TAB_SLUG_PATTERN.test(base)) {
    throw new Error(`workspace import tab slug is invalid: ${base}`);
  }
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, 40 - tail.length)}${tail}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error(`workspace import cannot allocate tab slug: ${base}`);
}

function importedCustomName(base: string, used: Set<string>): string {
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const tail = `-import-${suffix}`;
    const candidate = `${base.slice(0, 64 - tail.length)}${tail}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error(`workspace import cannot allocate custom widget name: ${base}`);
}

function allocateId(createId: () => string, used: Set<string>): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = createId();
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && !used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error("workspace import cannot allocate a collision-free resource id");
}

export function prepareWorkspaceImport(
  text: string,
  current: WorkspaceDoc,
  options: { createId?: () => string } = {},
): PreparedWorkspaceImport {
  const distribution = parseWorkspaceDistribution(text);
  const packageSlugs = new Set<string>();
  for (const tab of distribution.tabs) {
    if (packageSlugs.has(tab.slug)) {
      throw new Error(`workspace import contains duplicate tab slug: ${tab.slug}`);
    }
    packageSlugs.add(tab.slug);
  }

  const createId = options.createId ?? randomUUID;
  const usedTabIds = new Set(current.tabs.map((tab) => tab.id));
  const usedWidgetIds = new Set(
    current.tabs.flatMap((tab) => tab.widgets.map((widget) => widget.id)),
  );
  const usedSlugs = new Set(current.tabs.map((tab) => tab.slug));
  const usedCustomNames = new Set(Object.keys(current.widgetsRegistry));
  const customNameMap = new Map<string, string>();
  const registry: Record<string, WorkspaceWidgetRegistryEntry> = {};
  let customWidgets = 0;

  const tabs = distribution.tabs.map((tab): WorkspaceTab => {
    const id = allocateId(createId, usedTabIds);
    const widgets = tab.widgets.map((widget): WorkspaceWidget => {
      let kind = widget.kind;
      if (CUSTOM_KIND_PATTERN.test(kind)) {
        const original = kind.slice("custom:".length);
        let imported = customNameMap.get(original);
        if (!imported) {
          imported = importedCustomName(original, usedCustomNames);
          customNameMap.set(original, imported);
          registry[imported] = { status: "pending", createdBy: "user" };
        }
        kind = `custom:${imported}`;
        customWidgets += 1;
      } else if (!BUILTIN_WIDGET_KINDS.includes(kind as (typeof BUILTIN_WIDGET_KINDS)[number])) {
        throw new Error(`workspace import widget kind is invalid: ${kind}`);
      }
      const importedWidget: WorkspaceWidget = {
        id: allocateId(createId, usedWidgetIds),
        kind,
        grid: widget.grid,
        collapsed: widget.collapsed,
        hidden: widget.hidden,
        createdBy: "user",
      };
      if (widget.title !== undefined) {
        importedWidget.title = widget.title;
      }
      return importedWidget;
    });
    const importedTab: WorkspaceTab = {
      id,
      revision: 1,
      slug: uniqueSlug(tab.slug, usedSlugs),
      title: tab.title,
      hidden: tab.hidden,
      createdBy: "user",
      widgets,
    };
    if (tab.icon !== undefined) {
      importedTab.icon = tab.icon;
    }
    return importedTab;
  });

  validateWorkspaceDoc({
    schemaVersion: current.schemaVersion,
    workspaceId: current.workspaceId,
    workspaceVersion: current.workspaceVersion,
    tabs: [...current.tabs, ...tabs],
    widgetsRegistry: { ...current.widgetsRegistry, ...registry },
    prefs: { tabOrder: [...current.prefs.tabOrder, ...tabs.map((tab) => tab.slug)] },
  });

  return {
    baseWorkspaceVersion: current.workspaceVersion,
    tabs,
    registry,
    summary: {
      tabs: tabs.length,
      widgets: tabs.reduce((total, tab) => total + tab.widgets.length, 0),
      customWidgets,
    },
  };
}
