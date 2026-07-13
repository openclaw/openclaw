import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { rememberWorkspaceBroadcast } from "./broadcast.js";
import type {
  WorkspaceChangeRequestState,
  WorkspaceRequester,
  WorkspaceTabProposal,
} from "./change-requests.js";
import { resolveBinding, type ResolveBindingOptions } from "./data-read.js";
import { snapshotApprovedWidget } from "./manifest.js";
import { scaffoldWorkspaceWidget } from "./scaffold.js";
import type {
  WorkspaceActor,
  WorkspaceBinding,
  WorkspaceGrid,
  WorkspaceTab,
  WorkspaceWidget,
  JsonValue,
  WorkspaceDoc,
} from "./schema.js";
import { projectSharedChangeRequest, projectSharedTab } from "./sharing-projection.js";
import { WorkspaceStore } from "./store.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;
// Approving agent-authored widget code is an approval decision, not an ordinary
// layout write: it is the gate that lets untrusted HTML mount and be served.
// Holding operator.write must not be enough to self-approve.
const APPROVE_SCOPE = "operator.approvals" as const;
const TAB_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
const WIDGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const CUSTOM_WIDGET_NAME_PATTERN = /^(?!__proto__$)[A-Za-z0-9._-]{1,64}$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];
type GatewayRespond = GatewayMethodContext["respond"];
type GatewayBroadcast = GatewayMethodContext["context"]["broadcast"];
type TeamsRequestContext = Parameters<
  OpenClawPluginApi["teams"]["resources"]["owner"]
>[0]["context"];

type WorkspaceGatewayMethodOptions = {
  api: OpenClawPluginApi;
  store?: WorkspaceStore;
  storeForDomain?: (isolationDomainId: string) => WorkspaceStore;
  dataRead?: ResolveBindingOptions;
  /** Injectable clock for exact-tab presence tests. */
  presenceNow?: () => number;
};

type WorkspacePresenceParticipant = {
  id: string;
  kind: "human" | "agent";
  self: boolean;
};

const WORKSPACE_PRESENCE_TTL_MS = 30_000;
const MAX_WORKSPACE_PRESENCE_ENTRIES = 1_024;

type WorkspacePresenceEntry = {
  domainId: string;
  workspaceId: string;
  tabId: string;
  principalId: string;
  kind: "human" | "agent";
  seenAt: number;
};

function presenceKey(entry: Omit<WorkspacePresenceEntry, "seenAt">): string {
  return JSON.stringify([
    entry.domainId,
    entry.workspaceId,
    entry.tabId,
    entry.kind,
    entry.principalId,
  ]);
}

function createWorkspacePresenceRegistry(now: () => number) {
  const entries = new Map<string, WorkspacePresenceEntry>();

  const prune = (at: number) => {
    for (const [key, entry] of entries) {
      if (entry.seenAt + WORKSPACE_PRESENCE_TTL_MS <= at) {
        entries.delete(key);
      }
    }
    while (entries.size >= MAX_WORKSPACE_PRESENCE_ENTRIES) {
      const oldest = entries.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      entries.delete(oldest);
    }
  };

  return {
    touch(params: {
      context: TeamsRequestContext;
      workspaceId: string;
      tabId: string;
    }): WorkspacePresenceParticipant[] {
      const seenAt = now();
      prune(seenAt);
      const current = {
        domainId: params.context.isolationDomainId,
        workspaceId: params.workspaceId,
        tabId: params.tabId,
        principalId: params.context.principal.id,
        kind: params.context.principal.kind,
      } as const;
      const key = presenceKey(current);
      // Delete before set so insertion order also tracks recency for bounded eviction.
      entries.delete(key);
      entries.set(key, { ...current, seenAt });
      return [...entries.values()]
        .filter(
          (entry) =>
            entry.domainId === current.domainId &&
            entry.workspaceId === current.workspaceId &&
            entry.tabId === current.tabId,
        )
        .toSorted((left, right) => right.seenAt - left.seenAt)
        .map((entry) => ({
          id: entry.principalId,
          kind: entry.kind,
          self: entry.kind === current.kind && entry.principalId === current.principalId,
        }));
    },
  };
}

function respondError(respond: GatewayRespond, error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "workspace_error";
  respond(false, undefined, { code, message: formatErrorMessage(error) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approvedFilesMatch(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
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

// Gateway RPC is the operator's surface (Control UI and CLI). Provenance is
// derived from the caller, never read from params: a caller-supplied `RPC_ACTOR`
// would let an operator forge `agent:<id>` chips, and let any agent that can
// reach an operator.write RPC forge `user`.
const RPC_ACTOR: WorkspaceActor = "user";

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

function readResourceId(record: Record<string, unknown>, key: string): string {
  const id = readRequiredString(record, key, key);
  if (!RESOURCE_ID_PATTERN.test(id)) {
    throw new Error(`${key} is invalid`);
  }
  return id;
}

function readExactTabParams(params: unknown): { workspaceId: string; id: string } {
  const record = readParams(params, ["workspaceId", "id"]);
  return {
    workspaceId: readResourceId(record, "workspaceId"),
    id: readResourceId(record, "id"),
  };
}

function workspaceTabNotFound(): Error & { code: string } {
  return Object.assign(new Error("workspace tab not found"), { code: "workspace_not_found" });
}

function workspaceRevisionConflict(): Error & { code: string } {
  return Object.assign(new Error("workspace tab revision conflict"), {
    code: "workspace_conflict",
  });
}

function readOptionalRevision(record: Record<string, unknown>): number | undefined {
  const value = record.ifRevision;
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("ifRevision must be a positive integer");
  }
  return value as number;
}

function readRequiredRevision(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value as number;
}

function readChangeRequestState(
  record: Record<string, unknown>,
): WorkspaceChangeRequestState | undefined {
  const state = readOptionalString(record, "state");
  if (
    state !== undefined &&
    !["pending", "approved", "rejected", "cancelled", "conflict"].includes(state)
  ) {
    throw new Error("state is invalid");
  }
  return state as WorkspaceChangeRequestState | undefined;
}

function workspaceRequester(context: TeamsRequestContext): WorkspaceRequester {
  if (context.principal.kind === "human") {
    return { principalId: context.principal.id, kind: "human" };
  }
  if (!context.delegatedSession) {
    throw new Error("a delegated agent assignment is required");
  }
  return {
    principalId: context.principal.id,
    kind: "agent",
    delegationId: context.delegatedSession.id,
    sponsorPrincipalId: context.delegatedSession.sponsorPrincipalId,
  };
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

function readGrid(value: unknown, path = "grid"): WorkspaceGrid {
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

function makeUniqueSlug(title: string, tabs: WorkspaceTab[]): string {
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

function findTab(doc: WorkspaceDoc, slug: string): WorkspaceTab {
  const tab = doc.tabs.find((entry) => entry.slug === slug);
  if (!tab) {
    throw new Error(`workspace tab not found: ${slug}`);
  }
  return tab;
}

function findWidget(tab: WorkspaceTab, id: string): WorkspaceWidget {
  const widget = tab.widgets.find((entry) => entry.id === id);
  if (!widget) {
    throw new Error(`workspace widget not found: ${id}`);
  }
  return widget;
}

function readWidgetInput(
  value: unknown,
  doc: WorkspaceDoc,
  actor: WorkspaceActor,
): WorkspaceWidget {
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
    createdBy: actor,
    ...(value.bindings !== undefined
      ? { bindings: value.bindings as Record<string, WorkspaceBinding> }
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

function readTabPatch(value: unknown): Partial<Pick<WorkspaceTab, "title" | "icon" | "hidden">> {
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

function expandPortalProposal(tab: WorkspaceTab, value: unknown): unknown {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => ["title", "icon", "hidden"].includes(key))
  ) {
    return value;
  }
  const patch = readTabPatch(value);
  const proposal: WorkspaceTabProposal = {
    slug: tab.slug,
    title: patch.title ?? tab.title,
    ...((patch.icon ?? tab.icon) ? { icon: patch.icon ?? tab.icon } : {}),
    hidden: patch.hidden ?? tab.hidden,
    widgets: tab.widgets.map(({ createdBy: _createdBy, ...widget }) => widget),
  };
  return proposal;
}

function readWidgetPatch(value: unknown): Partial<WorkspaceWidget> {
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
      ? { bindings: patch.bindings as Record<string, WorkspaceBinding> }
      : {}),
    ...(patch.props !== undefined ? { props: patch.props as JsonValue } : {}),
  };
}

function readLayout(value: unknown): Array<{ id: string; grid: WorkspaceGrid }> {
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
  params: { doc: WorkspaceDoc; actor: WorkspaceActor; changedTabSlug?: string },
) {
  // Agent tool calls outside a gateway request reuse this handle; see broadcast.ts.
  rememberWorkspaceBroadcast(broadcast);
  broadcast("plugin.workspaces.changed", {
    workspaceVersion: params.doc.workspaceVersion,
    ...(params.changedTabSlug ? { changedTabSlug: params.changedTabSlug } : {}),
    actor: params.actor,
  });
}

async function respondWrite(
  opts: GatewayMethodContext,
  actor: WorkspaceActor,
  changedTabSlug: string | undefined,
  run: () => Promise<{ doc: WorkspaceDoc }>,
) {
  const result = await run();
  broadcastChange(opts.context.broadcast, { doc: result.doc, actor, changedTabSlug });
  opts.respond(true, { doc: result.doc, workspaceVersion: result.doc.workspaceVersion });
}

export function registerWorkspaceGatewayMethods(options: WorkspaceGatewayMethodOptions) {
  const { api } = options;
  const store = options.store ?? new WorkspaceStore();
  const storeForDomain = options.storeForDomain ?? (() => store);
  const presence = createWorkspacePresenceRegistry(options.presenceNow ?? Date.now);

  api.registerGatewayMethod(
    "workspaces.get",
    async ({ params: rawParams, respond, context }) => {
      try {
        const params = readParams(rawParams, ["workspaceId"]);
        const workspaceId =
          params.workspaceId === undefined
            ? store.workspaceId
            : readResourceId(params, "workspaceId");
        let readableStore = store;
        try {
          const teamsContext = api.teams.context.require();
          readableStore = storeForDomain(teamsContext.isolationDomainId);
        } catch {
          // Legacy operator requests have no isolated Teams context.
        }
        rememberWorkspaceBroadcast(context.broadcast);
        const doc = readableStore.read();
        if (doc.workspaceId !== workspaceId) {
          throw workspaceTabNotFound();
        }
        respond(true, { doc, workspaceVersion: doc.workspaceVersion });
      } catch (error) {
        respondError(respond, error);
      }
    },
    {
      scope: READ_SCOPE,
      access: {
        kind: "resource",
        permission: "workspaces.workspace.read",
        resolveResources: ({ params }) => {
          const record = readParams(params, ["workspaceId"]);
          const id =
            record.workspaceId === undefined
              ? store.workspaceId
              : readResourceId(record, "workspaceId");
          return [{ namespace: "workspaces", type: "workspace", id }];
        },
      },
    },
  );

  api.registerGatewayMethod(
    "workspaces.tab.get",
    async ({ params: rawParams, respond }) => {
      try {
        const params = readExactTabParams(rawParams);
        const teamsContext = api.teams.context.require();
        const domainStore = storeForDomain(teamsContext.isolationDomainId);
        const doc = domainStore.read();
        if (params.workspaceId !== doc.workspaceId) {
          throw workspaceTabNotFound();
        }
        const tab = doc.tabs.find((entry) => entry.id === params.id);
        if (!tab) {
          throw workspaceTabNotFound();
        }
        const resource = { namespace: "workspaces", type: "tab", id: tab.id } as const;
        const [write, requestChanges] = await Promise.all([
          api.teams.authorization.decide({
            context: teamsContext,
            permission: "workspaces.tab.write",
            resources: [resource],
          }),
          api.teams.authorization.decide({
            context: teamsContext,
            permission: "workspaces.tab.changeRequest.create",
            resources: [resource],
          }),
        ]);
        const capabilityMode = write.allowed
          ? "write"
          : requestChanges.allowed
            ? "request"
            : "read";
        respond(true, {
          workspaceId: doc.workspaceId,
          workspaceVersion: doc.workspaceVersion,
          capabilityMode,
          // Presence is derived only after exact-tab authorization and is keyed
          // by tenant + workspace + tab. No other tab membership is serialized.
          presence: presence.touch({
            context: teamsContext,
            workspaceId: doc.workspaceId,
            tabId: tab.id,
          }),
          tab: projectSharedTab(tab),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    {
      scope: READ_SCOPE,
      access: {
        kind: "resource",
        member: true,
        permission: "workspaces.tab.read",
        resolveResources: ({ params }) => {
          const exact = readExactTabParams(params);
          return [{ namespace: "workspaces", type: "tab", id: exact.id }];
        },
      },
    },
  );

  api.registerGatewayMethod(
    "workspaces.sharing.sync",
    async ({ params: rawParams, respond }) => {
      try {
        const params = readParams(rawParams, ["workspaceId"]);
        const workspaceId = readResourceId(params, "workspaceId");
        const context = api.teams.context.require();
        const domainStore = storeForDomain(context.isolationDomainId);
        if (workspaceId !== domainStore.workspaceId || context.principal.kind !== "human") {
          throw workspaceTabNotFound();
        }
        const workspace = { namespace: "workspaces", type: "workspace", id: workspaceId } as const;
        const owner = await api.teams.resources.owner({ context, resource: workspace });
        if (owner.principalId !== context.principal.id) {
          throw new Error("workspace sharing sync requires the canonical human owner");
        }
        const boundBefore = await api.teams.resources.listChildren({
          context,
          parent: workspace,
          requiredAction: "workspaces.workspace.manageSharing",
          type: "tab",
        });
        const doc = domainStore.read();
        const currentTabIds = new Set(doc.tabs.map((tab) => tab.id));
        for (const tab of doc.tabs) {
          const operation = await api.teams.resources.prepareRegister({
            context,
            resource: { namespace: "workspaces", type: "tab", id: tab.id },
            parent: workspace,
            requiredAction: "workspaces.workspace.manageSharing",
            idempotencyKey: `sharing-sync:${workspaceId}:${tab.id}`,
          });
          await api.teams.resources.replayPrepared({ operation });
        }
        for (const resource of boundBefore) {
          if (currentTabIds.has(resource.id)) {
            continue;
          }
          const operation = await api.teams.resources.prepareRetire({
            context,
            resource,
            parent: workspace,
            requiredAction: "workspaces.workspace.manageSharing",
            idempotencyKey: `sharing-sync-retire:${workspaceId}:${resource.id}`,
          });
          await api.teams.resources.replayPrepared({ operation });
        }
        respond(true, {
          workspaceId,
          tabs: doc.tabs.map(({ id, revision, slug, title }) => ({ id, revision, slug, title })),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    {
      scope: WRITE_SCOPE,
      access: {
        kind: "resource",
        member: true,
        permission: "workspaces.workspace.manageSharing",
        resolveResources: ({ params }) => {
          const record = readParams(params, ["workspaceId"]);
          return [
            {
              namespace: "workspaces",
              type: "workspace",
              id: readResourceId(record, "workspaceId"),
            },
          ];
        },
      },
    },
  );

  api.registerGatewayMethod(
    "workspaces.widget.frame",
    async ({ params: rawParams, respond }) => {
      try {
        const params = readParams(rawParams, ["name"]);
        const name = readRequiredString(params, "name", "name");
        if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
          throw new Error("name is invalid");
        }
        const entry = store.widgetEntry(name);
        if (entry?.status !== "approved" || !entry.approvedFiles) {
          throw new Error(`workspace widget is not approved: ${name}`);
        }
        const snapshot = await snapshotApprovedWidget(name, { stateDir: store.stateDir });
        if (!approvedFilesMatch(snapshot.files, entry.approvedFiles)) {
          throw new Error(`workspace widget approval no longer matches: ${name}`);
        }
        const frameToken = store.assetTokens.issue(name, entry.approvedFiles);
        const frameExpiresAt = store.assetTokens.expiresAt(frameToken, name);
        if (frameExpiresAt === null) {
          throw new Error(`workspace widget frame capability failed: ${name}`);
        }
        respond(true, {
          manifest: snapshot.manifest,
          frameToken,
          frameExpiresAt,
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.tab.create",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["slug", "title", "icon"]);
        const title = readRequiredString(params, "title", "title");
        const icon = readOptionalString(params, "icon");
        const result = store.mutate(
          (draft) => {
            const slug =
              params.slug === undefined ? makeUniqueSlug(title, draft.tabs) : readSlug(params);
            if (draft.tabs.some((tab) => tab.slug === slug)) {
              throw new Error(`workspace tab already exists: ${slug}`);
            }
            draft.tabs.push({
              id: randomUUID(),
              revision: 1,
              slug,
              title,
              ...(icon !== undefined ? { icon } : {}),
              hidden: false,
              createdBy: RPC_ACTOR,
              widgets: [],
            });
            draft.prefs.tabOrder.push(slug);
          },
          { actor: RPC_ACTOR },
        );
        const changedTabSlug = result.doc.tabs.at(-1)?.slug;
        broadcastChange(opts.context.broadcast, {
          doc: result.doc,
          actor: RPC_ACTOR,
          changedTabSlug,
        });
        opts.respond(true, { doc: result.doc, workspaceVersion: result.doc.workspaceVersion });
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.tab.update",
    async (opts) => {
      try {
        const params = readParams(opts.params, [
          "workspaceId",
          "id",
          "slug",
          "ifRevision",
          "patch",
        ]);
        const patch = readTabPatch(params.patch);
        let teamsContext: TeamsRequestContext | undefined;
        try {
          teamsContext = api.teams.context.require();
        } catch {
          // Legacy operator request.
        }
        const ifRevision = teamsContext
          ? readRequiredRevision(params, "ifRevision")
          : readOptionalRevision(params);
        const targetStore = teamsContext ? storeForDomain(teamsContext.isolationDomainId) : store;
        if (teamsContext && readResourceId(params, "workspaceId") !== targetStore.workspaceId) {
          throw workspaceTabNotFound();
        }
        if (!teamsContext && params.workspaceId !== undefined) {
          throw new Error("workspaceId is only accepted for exact Teams updates");
        }
        const id = teamsContext ? readResourceId(params, "id") : undefined;
        const slug = teamsContext ? undefined : readSlug(params);
        let changedTabSlug: string | undefined;
        const actor: WorkspaceActor =
          teamsContext?.principal.kind === "agent"
            ? `agent:${teamsContext.principal.id}`
            : RPC_ACTOR;
        const result = targetStore.mutate(
          (draft) => {
            const tab = id ? draft.tabs.find((entry) => entry.id === id) : findTab(draft, slug!);
            if (!tab) {
              throw workspaceTabNotFound();
            }
            if (ifRevision !== undefined && tab.revision !== ifRevision) {
              throw workspaceRevisionConflict();
            }
            changedTabSlug = tab.slug;
            Object.assign(tab, patch);
          },
          { actor },
        );
        if (teamsContext && id) {
          const updatedTab = result.doc.tabs.find((entry) => entry.id === id);
          if (!updatedTab) {
            throw workspaceTabNotFound();
          }
          // Teams portal v1 polls exact resources until the host supports
          // permission-filtered resource events. Never use the global broadcast.
          opts.respond(true, {
            workspaceId: result.doc.workspaceId,
            workspaceVersion: result.doc.workspaceVersion,
            tab: projectSharedTab(updatedTab),
          });
        } else {
          broadcastChange(opts.context.broadcast, { doc: result.doc, actor, changedTabSlug });
          opts.respond(true, { doc: result.doc, workspaceVersion: result.doc.workspaceVersion });
        }
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    {
      scope: WRITE_SCOPE,
      access: {
        kind: "resource",
        member: true,
        permission: "workspaces.tab.write",
        resolveResources: ({ params }) => {
          const record = readParams(params, ["workspaceId", "id", "slug", "ifRevision", "patch"]);
          return [{ namespace: "workspaces", type: "tab", id: readResourceId(record, "id") }];
        },
      },
    },
  );

  const exactTabAccess = (permission: string) => ({
    kind: "resource" as const,
    member: true,
    permission,
    resolveResources: ({ params }: { params: unknown }) => {
      const record = readParams(params, [
        "workspaceId",
        "tabId",
        "requestId",
        "baseRevision",
        "proposal",
        "idempotencyKey",
        "state",
        "decision",
        "reason",
      ]);
      return [
        {
          namespace: "workspaces",
          type: "tab",
          id: readResourceId(record, "tabId"),
        },
      ];
    },
  });

  api.registerGatewayMethod(
    "workspaces.changeRequest.create",
    async ({ params: rawParams, respond }) => {
      try {
        const params = readParams(rawParams, [
          "workspaceId",
          "tabId",
          "baseRevision",
          "proposal",
          "idempotencyKey",
        ]);
        const context = api.teams.context.require();
        const domainStore = storeForDomain(context.isolationDomainId);
        if (readResourceId(params, "workspaceId") !== domainStore.workspaceId) {
          throw workspaceTabNotFound();
        }
        const tabId = readResourceId(params, "tabId");
        const tab = domainStore.read().tabs.find((entry) => entry.id === tabId);
        if (!tab) {
          throw workspaceTabNotFound();
        }
        const request = domainStore.createChangeRequest({
          id: randomUUID(),
          tabId,
          requester: workspaceRequester(context),
          baseTabRevision: readRequiredRevision(params, "baseRevision"),
          idempotencyKey: readRequiredString(params, "idempotencyKey", "idempotencyKey"),
          proposal: expandPortalProposal(tab, params.proposal),
        });
        respond(true, { request: projectSharedChangeRequest(request) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    {
      scope: WRITE_SCOPE,
      access: exactTabAccess("workspaces.tab.changeRequest.create"),
    },
  );

  api.registerGatewayMethod(
    "workspaces.changeRequest.list",
    async ({ params: rawParams, respond }) => {
      try {
        const params = readParams(rawParams, ["workspaceId", "tabId", "state"]);
        const context = api.teams.context.require();
        const domainStore = storeForDomain(context.isolationDomainId);
        if (readResourceId(params, "workspaceId") !== domainStore.workspaceId) {
          throw workspaceTabNotFound();
        }
        const tabId = readResourceId(params, "tabId");
        const resource = { namespace: "workspaces", type: "tab", id: tabId } as const;
        const owner = await api.teams.resources.owner({ context, resource });
        const isOwner =
          context.principal.kind === "human" && owner.principalId === context.principal.id;
        const requests = domainStore.listChangeRequests({
          tabId,
          ...(readChangeRequestState(params) ? { state: readChangeRequestState(params) } : {}),
          ...(isOwner ? {} : { requesterPrincipalId: context.principal.id }),
        });
        respond(true, {
          requests: isOwner ? requests : requests.map(projectSharedChangeRequest),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE, access: exactTabAccess("workspaces.tab.read") },
  );

  api.registerGatewayMethod(
    "workspaces.changeRequest.get",
    async ({ params: rawParams, respond }) => {
      try {
        const params = readParams(rawParams, ["workspaceId", "tabId", "requestId"]);
        const context = api.teams.context.require();
        const domainStore = storeForDomain(context.isolationDomainId);
        if (readResourceId(params, "workspaceId") !== domainStore.workspaceId) {
          throw workspaceTabNotFound();
        }
        const tabId = readResourceId(params, "tabId");
        const request = domainStore.readChangeRequest(readResourceId(params, "requestId"));
        if (!request || request.tabId !== tabId) {
          throw workspaceTabNotFound();
        }
        const owner = await api.teams.resources.owner({
          context,
          resource: { namespace: "workspaces", type: "tab", id: tabId },
        });
        const isOwner =
          context.principal.kind === "human" && owner.principalId === context.principal.id;
        if (!isOwner && request.requester.principalId !== context.principal.id) {
          throw workspaceTabNotFound();
        }
        respond(true, { request: isOwner ? request : projectSharedChangeRequest(request) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE, access: exactTabAccess("workspaces.tab.read") },
  );

  api.registerGatewayMethod(
    "workspaces.changeRequest.cancel",
    async ({ params: rawParams, respond }) => {
      try {
        const params = readParams(rawParams, ["workspaceId", "tabId", "requestId"]);
        const context = api.teams.context.require();
        const domainStore = storeForDomain(context.isolationDomainId);
        if (readResourceId(params, "workspaceId") !== domainStore.workspaceId) {
          throw workspaceTabNotFound();
        }
        const tabId = readResourceId(params, "tabId");
        const existing = domainStore.readChangeRequest(readResourceId(params, "requestId"));
        if (!existing || existing.tabId !== tabId) {
          throw workspaceTabNotFound();
        }
        const requester = workspaceRequester(context);
        if (JSON.stringify(existing.requester) !== JSON.stringify(requester)) {
          throw workspaceTabNotFound();
        }
        const request = domainStore.cancelChangeRequest({
          id: existing.id,
          requester,
        });
        respond(true, { request: projectSharedChangeRequest(request) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    {
      scope: WRITE_SCOPE,
      access: exactTabAccess("workspaces.tab.changeRequest.create"),
    },
  );

  api.registerGatewayMethod(
    "workspaces.changeRequest.decide",
    async ({ params: rawParams, respond }) => {
      try {
        const params = readParams(rawParams, [
          "workspaceId",
          "tabId",
          "requestId",
          "decision",
          "reason",
        ]);
        const context = api.teams.context.require();
        if (context.principal.kind !== "human") {
          throw new Error("change request decisions require the canonical human owner");
        }
        const domainStore = storeForDomain(context.isolationDomainId);
        if (readResourceId(params, "workspaceId") !== domainStore.workspaceId) {
          throw workspaceTabNotFound();
        }
        const tabId = readResourceId(params, "tabId");
        const resource = { namespace: "workspaces", type: "tab", id: tabId } as const;
        const owner = await api.teams.resources.owner({ context, resource });
        if (owner.principalId !== context.principal.id) {
          throw new Error("change request decisions require the canonical human owner");
        }
        const existing = domainStore.readChangeRequest(readResourceId(params, "requestId"));
        if (!existing || existing.tabId !== tabId) {
          throw workspaceTabNotFound();
        }
        const decision = readRequiredString(params, "decision", "decision");
        if (decision !== "approved" && decision !== "rejected") {
          throw new Error("decision must be approved or rejected");
        }
        const result = domainStore.decideChangeRequest({
          id: existing.id,
          decision,
          decider: { principalId: context.principal.id, kind: "human" },
          reason: readOptionalString(params, "reason"),
        });
        const tab = result.doc.tabs.find((entry) => entry.id === tabId);
        respond(true, {
          workspaceId: result.doc.workspaceId,
          request: projectSharedChangeRequest(result.request),
          applied: result.applied,
          workspaceVersion: result.doc.workspaceVersion,
          ...(tab ? { tab: projectSharedTab(tab) } : {}),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    {
      scope: APPROVE_SCOPE,
      access: exactTabAccess("workspaces.tab.reviewChanges"),
    },
  );

  api.registerGatewayMethod(
    "workspaces.tab.delete",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["slug"]);
        const slug = readSlug(params);
        await respondWrite(opts, RPC_ACTOR, slug, async () =>
          store.mutate(
            (draft) => {
              const nextTabs = draft.tabs.filter((tab) => tab.slug !== slug);
              if (nextTabs.length === draft.tabs.length) {
                throw new Error(`workspace tab not found: ${slug}`);
              }
              draft.tabs = nextTabs;
              draft.prefs.tabOrder = draft.prefs.tabOrder.filter((entry) => entry !== slug);
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.tab.reorder",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["order"]);
        const order = readSlugOrder(params.order);
        await respondWrite(opts, RPC_ACTOR, undefined, async () =>
          store.mutate(
            (draft) => {
              const slugs = new Set(draft.tabs.map((tab) => tab.slug));
              for (const slug of order) {
                if (!slugs.has(slug)) {
                  throw new Error(`workspace tab not found: ${slug}`);
                }
              }
              draft.prefs.tabOrder = order;
              appendMissingTabsToOrder(draft);
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.add",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "widget"]);
        const slug = readRequiredString(params, "tab", "tab");
        await respondWrite(opts, RPC_ACTOR, slug, async () =>
          store.mutate(
            (draft) => {
              findTab(draft, slug).widgets.push(readWidgetInput(params.widget, draft, RPC_ACTOR));
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.update",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "id", "patch"]);
        const slug = readRequiredString(params, "tab", "tab");
        const id = readWidgetId(params);
        const patch = readWidgetPatch(params.patch);
        await respondWrite(opts, RPC_ACTOR, slug, async () =>
          store.mutate(
            (draft) => {
              Object.assign(findWidget(findTab(draft, slug), id), patch);
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.move",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "id", "grid", "toTab"]);
        if (params.grid !== undefined && params.toTab !== undefined) {
          throw new Error("workspaces.widget.move accepts either grid or toTab, not both");
        }
        const id = readWidgetId(params);
        const changedTabSlug =
          typeof params.toTab === "string"
            ? params.toTab
            : typeof params.tab === "string"
              ? params.tab
              : undefined;
        await respondWrite(opts, RPC_ACTOR, changedTabSlug, async () =>
          store.mutate(
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
              throw new Error(`workspace widget not found: ${id}`);
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.remove",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "id"]);
        const slug = readRequiredString(params, "tab", "tab");
        const id = readWidgetId(params);
        await respondWrite(opts, RPC_ACTOR, slug, async () =>
          store.mutate(
            (draft) => {
              const tab = findTab(draft, slug);
              const next = tab.widgets.filter((widget) => widget.id !== id);
              if (next.length === tab.widgets.length) {
                throw new Error(`workspace widget not found: ${id}`);
              }
              tab.widgets = next;
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.setLayout",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["tab", "layout"]);
        const slug = readRequiredString(params, "tab", "tab");
        const layout = readLayout(params.layout);
        await respondWrite(opts, RPC_ACTOR, slug, async () =>
          store.mutate(
            (draft) => {
              const tab = findTab(draft, slug);
              for (const entry of layout) {
                findWidget(tab, entry.id).grid = entry.grid;
              }
            },
            { actor: RPC_ACTOR },
          ),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  // Scaffolding over RPC exists so the CLI creates a widget through the same
  // store path the agent tool uses. Without it the CLI had to read-modify-write
  // the whole document through `workspace.replace`, which is both racy and the
  // only way it could mark its own widget approved.
  api.registerGatewayMethod(
    "workspaces.widget.scaffold",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["name", "title"]);
        const name = readRequiredString(params, "name", "name");
        const title = readOptionalString(params, "title");
        const scaffold = await scaffoldWorkspaceWidget({
          name,
          ...(title !== undefined ? { title } : {}),
          stateDir: store.stateDir,
          createdBy: RPC_ACTOR,
        });
        const result = store.mutate(
          (draft) => {
            // Operator-scaffolded or agent-scaffolded, a widget always starts
            // pending: approval is a separate, separately-scoped decision.
            draft.widgetsRegistry[scaffold.name] = { status: "pending", createdBy: RPC_ACTOR };
          },
          { actor: RPC_ACTOR },
        );
        broadcastChange(opts.context.broadcast, { doc: result.doc, actor: RPC_ACTOR });
        opts.respond(true, {
          ...scaffold,
          registry: result.doc.widgetsRegistry[scaffold.name],
          workspaceVersion: result.doc.workspaceVersion,
        });
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.widget.approve",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["name", "decision"]);
        const name = readRequiredString(params, "name", "name");
        if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
          throw new Error("name is invalid");
        }
        const decision = readRequiredString(params, "decision", "decision");
        if (decision !== "approved" && decision !== "rejected") {
          throw new Error("decision must be approved or rejected");
        }
        // What the operator approves is the code on disk, not the name. Freeze a
        // digest of every servable file: the route re-hashes what it reads, so an
        // agent cannot win approval on one tree and then write another.
        // One read of the widget directory: the manifest is parsed from the same
        // bytes that are hashed, so no swap can slip between validation and freeze.
        const approvedFiles =
          decision === "approved"
            ? (await snapshotApprovedWidget(name, { stateDir: store.stateDir })).files
            : undefined;
        const result = store.mutate(
          (draft) => {
            const existing = draft.widgetsRegistry[name];
            if (!existing) {
              throw new Error(`workspace widget not found: ${name}`);
            }
            draft.widgetsRegistry[name] = {
              status: decision,
              createdBy: existing.createdBy,
              ...(approvedFiles
                ? {
                    approvedBy: RPC_ACTOR,
                    approvedAt: new Date().toISOString(),
                    approvedFiles,
                  }
                : {}),
            };
          },
          { actor: RPC_ACTOR },
        );
        broadcastChange(opts.context.broadcast, { doc: result.doc, actor: RPC_ACTOR });
        // A connection holding only operator.approvals must not read the workspace
        // through this method; `workspaces.get` is the operator.read door.
        opts.respond(true, {
          name,
          registry: result.doc.widgetsRegistry[name],
          workspaceVersion: result.doc.workspaceVersion,
        });
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: APPROVE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.replace",
    async (opts) => {
      try {
        const params = readParams(opts.params, ["doc"]);
        await respondWrite(opts, RPC_ACTOR, undefined, async () =>
          store.replace(params.doc, { actor: RPC_ACTOR }),
        );
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.undo",
    async (opts) => {
      try {
        readParams(opts.params, []);
        const doc = store.undo();
        broadcastChange(opts.context.broadcast, { doc, actor: RPC_ACTOR });
        opts.respond(true, { doc, workspaceVersion: doc.workspaceVersion });
      } catch (error) {
        respondError(opts.respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workspaces.data.read",
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
