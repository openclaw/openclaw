import { createHash, randomUUID } from "node:crypto";
import type {
  FeatureHandlers,
  FeatureEventEmitter,
  FeatureInvocationContext,
} from "openclaw/plugin-sdk/feature-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Check } from "typebox/value";
import { featurePrincipal, toolGrant, type VaultAccess } from "./access.js";
import { attachWorkspaceFile } from "./attachment-file.js";
import { SinceInput, LastSeenInput } from "./chronicle-contract.js";
import { emptyChronicle } from "./chronicle.js";
import { contract } from "./contract.js";
import { buildKnowledgeLearnGuidance, KNOWLEDGE_LEARN_TOOL_NAMES } from "./learn-guidance.js";
import {
  RECORD_MAX_BYTES,
  BODY_INPUT_MAX_CHARS,
  TEXT_PAGE_MAX_CHARS,
  RECORD_RESPONSE_MAX_BYTES,
} from "./limits.js";
import { Maintenance } from "./maintenance.js";
import { buildKnowledgeMemoryFlushPlan } from "./memory-flush.js";
import { registerMemoryIndexHook } from "./memory-index-hook.js";
import { buildKnowledgeMemoryPrompt } from "./memory-prompt.js";
import { createKnowledgeMemoryRuntime } from "./memory-provider.js";
import { locatePluginFiles } from "./plugin-files.js";
import { queryFreshness } from "./query-freshness.js";
import { searchDetail } from "./search-detail.js";
import type { StorageOperations } from "./storage-host.js";
import { createStoreOperations } from "./store-assignments.js";
import type { StoreRuntime } from "./store-runtime.js";
import { parsePolicy } from "./stores-config.js";
import type { StoreState } from "./stores-contract.js";
import { Stores } from "./stores.js";

type Handlers = FeatureHandlers<typeof contract>;
// StorageClient.call with its per-operation input tuple erased, for calls made with a generic Op.
type StorageCall<Op extends keyof StorageOperations> = (
  op: Op,
  access: VaultAccess,
  input?: unknown,
) => Promise<Awaited<ReturnType<StorageOperations[Op]>>>;
type StoreHandlers = Omit<
  Handlers,
  | "stores_snapshot"
  | "stores_change"
  | "stores_grant"
  | "stores_change_status"
  | "agent_query"
  | "agent_action"
  | "maintenance_status"
>;
const WRITE_TOOLS = new Set([
  "knowledge_remember",
  "knowledge_relink",
  "knowledge_edit_body",
  "knowledge_extract_section",
  "knowledge_reconcile_evidence",
  "knowledge_save_page",
  "knowledge_correct",
  "knowledge_withdraw",
  "knowledge_supersede",
  "knowledge_merge",
  "knowledge_unmerge",
  "knowledge_recall",
]);
const chatOnly = () =>
  new Error("Knowledge changes must be requested through chat and agent tools.");
const operatorOnly = () =>
  new Error(
    "Selecting an agent's store is an operator inspection; it is not available to agent tools.",
  );

const normalizeFlushTitle = (title: string) =>
  title.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

/** Derive a stable UUIDv8 request ID for one title within one host memory flush. */
export function deriveMemoryFlushRequestId(flushId: string, title: string): string {
  const bytes = createHash("sha256")
    .update("knowledge-memory-flush\0")
    .update(flushId)
    .update("\0")
    .update(normalizeFlushTitle(title))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createKnowledgeService(
  api: OpenClawPluginApi,
  events?: FeatureEventEmitter<typeof contract>,
): Handlers {
  // Metadata-only registration has no runtime entry and never starts storage.
  if (api.runtimeSource) {
    locatePluginFiles(api.runtimeSource);
  }
  const instanceId = randomUUID(),
    startedAt = new Date().toISOString();
  const policy = parsePolicy(api.pluginConfig);
  const stores = new Stores(api, policy, () => {
    try {
      events?.emit("changed", {});
    } catch {
      /* Reload/reconnect snapshots recover missed hints. */
    }
  });
  if (typeof api.registerMemoryCapability === "function") {
    api.registerMemoryCapability({
      providerRuntime: createKnowledgeMemoryRuntime(stores),
      recallToolNames: ["knowledge_grep", "knowledge_lookup", "knowledge_record"],
      // Every agent has an effective store, so every agent gets the guidance.
      // A read-only owner grant keeps save guidance out of that conversation's
      // prompt; its write tools still refuse. The session key only selects
      // guidance here, never access.
      promptBuilder: (params) =>
        buildKnowledgeMemoryPrompt({
          ...params,
          availableTools:
            policy.writesEnabled &&
            !(params.agentSessionKey && stores.grantFor(params.agentSessionKey) === "read")
              ? params.availableTools
              : new Set([...params.availableTools].filter((t) => !WRITE_TOOLS.has(t))),
        }),
      // The selected provider owns persistence through the host-completed resolver;
      // write-disabled installs suppress Memory Core's append-only file plan with an explicit null.
      providerFlushPlanResolver: () =>
        policy.writesEnabled ? buildKnowledgeMemoryFlushPlan() : null,
      // Write-disabled installs contribute no /learn guidance; Skill Workshop still can.
      ...(policy.writesEnabled
        ? {
            learnToolNames: KNOWLEDGE_LEARN_TOOL_NAMES,
            learnGuidanceBuilder: buildKnowledgeLearnGuidance,
          }
        : {}),
    });
  }
  if (typeof api.on === "function") {
    registerMemoryIndexHook(api, stores);
  }
  const maintenance = new Maintenance(stores, {
    info: (m) => api.logger?.info?.(m),
    warn: (m) => api.logger?.warn?.(m),
  });
  // The host service scheduler owns maintenance timing for this service
  // lifetime; stop() retires its jobs. No cron job or conversation hook.
  api.registerService?.({
    apiVersion: 2,
    id: "knowledge:live-state",
    async start(ctx) {
      stores.start();
      if (ctx?.scheduler) {
        await maintenance.start(ctx.scheduler);
      }
    },
    // A maintenance pass writes through the registry, so the registry closes only
    // after the pass has settled; the stores are fenced immediately.
    stop() {
      return stores.stop(maintenance.stop());
    },
  });
  // Instance disposal runs after the host drains admitted calls. Knowledge ends
  // for good and resolves only once its workers have exited and maintenance has
  // stopped, so a replacement generation never opens a store this one holds.
  api.lifecycle?.onDispose?.(() => stores.dispose(maintenance.stop()));

  /** Handlers bound to one operator viewing selection. Tools always resolve
   * their store from the host audience; `agent` only applies to operators. */
  const storeHandlers = (agent?: string): StoreHandlers => {
    // Resolve, then run inside the store's lane. Agent tools may create a
    // never-provisioned store; operator inspection never does.
    const use = async <T>(
      context: FeatureInvocationContext,
      write: boolean,
      work: (runtime: StoreRuntime, access: VaultAccess) => Promise<T>,
      whenEmpty?: () => T,
    ): Promise<T> => {
      if (write && !policy.writesEnabled) {
        throw new Error("Knowledge writes are disabled.");
      }
      const opened = await stores.open(
        featurePrincipal(
          context,
          policy.operatorRead,
          write,
          agent ?? stores.defaultAgent(),
          stores.grantFor,
        ),
        { provision: context.source === "tool" },
        stores.incarnation,
      );
      if (opened.kind !== "ready") {
        if (opened.kind === "unprovisioned" && whenEmpty) {
          return whenEmpty();
        }
        throw new Error(opened.message);
      }
      const access = {
        ...opened.access,
        ...(context.source === "tool" &&
        context.tool.sessionKey &&
        context.tool.sessionId &&
        context.toolCallId
          ? {
              activity: {
                sessionKey: context.tool.sessionKey,
                sessionId: context.tool.sessionId,
                toolCallId: context.toolCallId,
                operation: "knowledge",
                at: new Date().toISOString(),
              },
            }
          : {}),
      };
      const result = await opened.runtime.enqueue(access.assertCurrent, () =>
        work(opened.runtime, access),
      );
      if (write && opened.access.scope.visibility === "private") {
        opened.runtime.live.invalidate();
      }
      return result;
    };
    // A plain storage call: one worker operation in the resolved store.
    const call =
      <Op extends keyof StorageOperations>(
        op: Op,
        write = false,
        whenEmpty?: () => Awaited<ReturnType<StorageOperations[Op]>>,
      ) =>
      (input: unknown, context: FeatureInvocationContext) =>
        use(
          context,
          write,
          (runtime, access) =>
            // SAFETY: the host validated input against this operation's schema; erases the per-Op rest tuple.
            (runtime.client.call as StorageCall<Op>)(op, access, input),
          whenEmpty,
        );
    // Agent-only changes reject (never throw synchronously) for other callers.
    const agentChange =
      <Op extends keyof StorageOperations>(op: Op) =>
      (input: unknown, context: FeatureInvocationContext) =>
        context.source !== "tool" ? Promise.reject(chatOnly()) : call(op, true)(input, context);
    const authored =
      <Op extends "save" | "createClaim" | "createRelationship">(op: Op) =>
      (input: unknown, context: FeatureInvocationContext) =>
        use(context, true, (runtime, access) =>
          // SAFETY: the host validated input against this operation's schema; erases the per-Op rest tuple.
          (runtime.client.call as StorageCall<Op>)(op, access, {
            value: input,
            actor: context.source === "tool" ? "agent" : "operator",
          }),
        );
    const now = () => new Date().toISOString();
    return {
      session_activity: (input, context) =>
        context.source !== "session-action"
          ? Promise.reject(operatorOnly())
          : call("sessionActivity", false, () => ({ upper: 0, nextBefore: null, items: [] }))(
              input,
              context,
            ),
      verify: call("verify"),
      source_check: call("sourceCheck"),
      publish_batch: agentChange("batch"),
      annotate: agentChange("annotate"),
      reconcile_evidence: agentChange("reconcileEvidence"),
      edit_body: agentChange("editBody"),
      extract_section: agentChange("extractSection"),
      timeline: (input, context) =>
        call("timeline", false, () => emptyChronicle(input))(input, context),
      chronicle_day: (input, context) =>
        call("chronicleDay", false, () => {
          const { date: _date, timezone: _zone, week: _week, ...filters } = input;
          return emptyChronicle(filters, input);
        })(input, context),
      chronicle_since: (input, context) =>
        call("chronicleSince", false, () => {
          if (!Check(SinceInput, input)) {
            throw new Error("Invalid since query input.");
          }
          return emptyChronicle(input);
        })(input, context),
      chronicle_last_seen: (input, context) =>
        call("chronicleLastSeen", false, () => {
          if (!Check(LastSeenInput, input)) {
            throw new Error("Invalid last-seen input.");
          }
          const cutoff = input.occurredOnOrBefore ?? now(),
            result = emptyChronicle({
              entity: input.entity,
              until: cutoff,
              eligibility: input.eligibility,
              includeSources: input.includeSources,
            });
          return {
            entity: input.entity,
            selection: {
              timeField: "occurred_at" as const,
              onOrBefore: cutoff,
              eligibility: input.eligibility ?? ("current" as const),
            },
            last: null,
            snapshot: result.snapshot,
            freshness: result.freshness,
            ...(result.sources ? { sources: result.sources } : {}),
            message:
              "This store has not been provisioned; no dated context is available. Absence is not proof of no interaction.",
          };
        })(input, context),
      recent: call("recent", false, () => ({ items: [], upperSequence: 0, nextBefore: null })),
      attach: call("attach", true),
      attach_file: (input, context) =>
        use(context, true, (runtime, access) =>
          attachWorkspaceFile(input, context, access.assertCurrent, (chunk) =>
            runtime.client.call("attach", access, chunk),
          ),
        ),
      attachment: call("attachment"),
      evidence_read: call("evidenceRead"),
      // Inside a host pre-compaction flush, a missing requestId is derived from
      // the flush and title so the flush's retries replay instead of duplicating.
      save_page: (input, context) => {
        const flushId = context.source === "tool" ? context.tool.memoryFlush?.flushId : undefined;
        if (input.requestId === undefined && !flushId) {
          return Promise.reject(
            new Error(
              "knowledge_save_page requires requestId outside a host pre-compaction memory flush.",
            ),
          );
        }
        return authored("save")(
          {
            ...input,
            requestId: input.requestId ?? deriveMemoryFlushRequestId(flushId!, input.title),
          },
          context,
        );
      },
      // Same flush rule as save_page; the claim texts stand in for the title.
      remember: (input, context) => {
        const flushId = context.source === "tool" ? context.tool.memoryFlush?.flushId : undefined;
        if (input.requestId === undefined && !flushId) {
          return Promise.reject(
            new Error(
              "knowledge_remember requires requestId outside a host pre-compaction memory flush.",
            ),
          );
        }
        return agentChange("remember")(
          {
            ...input,
            requestId:
              input.requestId ??
              deriveMemoryFlushRequestId(flushId!, input.items.map((i) => i.text).join("\n")),
          },
          context,
        );
      },
      relink: (input, context) =>
        input.dryRun
          ? context.source !== "tool"
            ? Promise.reject(chatOnly())
            : call("relink")(input, context)
          : agentChange("relink")(input, context),
      create_claim: authored("createClaim"),
      create_relationship: authored("createRelationship"),
      correct: agentChange("correct"),
      withdraw: agentChange("withdraw"),
      supersede: agentChange("supersede"),
      merge: agentChange("merge"),
      unmerge: agentChange("unmerge"),
      recall: async (input, context) => {
        if (context.source !== "tool") {
          throw new Error(
            "Automatic recall approval is available only through an agent tool call; browser and operator actions are not allowed.",
          );
        }
        // The owner's own conversations approve recall, and so do conversations
        // the owner let save to private knowledge; a read-only grant refuses
        // below like any other save. Grants load with the registry.
        await stores.ensure();
        if (
          context.tool.memoryAudience?.kind !== "owner-private" &&
          !toolGrant(context, stores.grantFor)
        ) {
          throw new Error(
            "Automatic recall approval requires the owner's private memory audience or an owner grant to read and save private knowledge.",
          );
        }
        return use(context, true, (runtime, access) =>
          runtime.client.call("recall", access, input),
        );
      },
      connections: call("connections"),
      resume: (input, context) =>
        use(context, true, (runtime, access) =>
          runtime.client.call("resume", access, { requestId: input.requestId }),
        ),
      revision: (input, context) =>
        use(context, false, (runtime, access) => runtime.client.call("revision", access, input)),
      mutation: call("mutation"),
      history: call("history", false, () => ({
        entries: [],
        mutations: [],
        nextOffset: null,
        git: { state: "idle" as const, pending: 0, message: "Nothing saved here yet." },
      })),
      status: async (_, context) => {
        const opened = await stores.open(
          featurePrincipal(
            context,
            policy.operatorRead,
            false,
            agent ?? stores.defaultAgent(),
            stores.grantFor,
          ),
          { provision: false },
          stores.incarnation,
        );
        const base = {
          service: "knowledge" as const,
          phase: policy.writesEnabled
            ? ("structured-writes" as const)
            : ("read-only-explorer" as const),
          backendRevision: "memory-provider-v2-2+stores-v1+capacity-v1",
          instanceId,
          startedAt,
          limits: {
            recordBytes: RECORD_MAX_BYTES,
            bodyInputChars: BODY_INPUT_MAX_CHARS,
            textPageChars: TEXT_PAGE_MAX_CHARS,
            recordResponseBytes: RECORD_RESPONSE_MAX_BYTES,
          },
        };
        const notReady = (
          agentId: string,
          store: Exclude<StoreState, "ready">,
          message: string,
        ) => ({
          ...base,
          checkedAt: now(),
          vault: "",
          agent: agentId,
          store,
          scope: "private",
          writesEnabled: false,
          live: "stopped" as const,
          records: 0,
          validRecords: 0,
          definitions: 0,
          ontologyAvailable: false,
          ontologyFingerprint: "",
          issues: 0,
          message: message.slice(0, 300),
        });
        if (opened.kind !== "ready") {
          return notReady(opened.agentId, opened.kind, opened.message);
        }
        const { runtime, access } = opened;
        const scope =
          access.scope.visibility === "conversation"
            ? `conversation:${access.scope.sessionId}`
            : "private";
        let catalog;
        try {
          catalog = await runtime.enqueue(access.assertCurrent, () =>
            runtime.client.call("catalog", access),
          );
        } catch (e) {
          // A provisioned store that fails its identity checks is reported, never replaced.
          // SAFETY: the store runtime and storage client reject only with Error objects.
          if (!(e as Error).message.includes("identity or storage is unavailable")) {
            throw e;
          }
          return notReady(
            access.agentId,
            "unavailable",
            // SAFETY: the store runtime and storage client reject only with Error objects.
            `This store couldn't be opened. ${(e as Error).message}`,
          );
        }
        if (scope === "private") {
          runtime.live.ensureWatching();
        }
        const canWrite =
          policy.writesEnabled &&
          ((context.source === "tool" && toolGrant(context, stores.grantFor) !== "read") ||
            (context.source === "session-action" &&
              Boolean(
                context.action.client?.scopes.some(
                  (s: string) => s === "operator.write" || s === "operator.admin",
                ),
              )));
        return {
          ...base,
          checkedAt: catalog.checkedAt,
          vault: runtime.vaultId,
          agent: access.agentId,
          store: "ready" as const,
          scope,
          writesEnabled: canWrite,
          live: scope === "private" ? runtime.live.state : "stopped",
          snapshot: catalog.snapshot,
          records: catalog.records,
          validRecords: catalog.records,
          definitions: catalog.definitions,
          ontologyAvailable: catalog.ontologyAvailable,
          ontologyFingerprint: catalog.ontologyFingerprint,
          issues: catalog.issues,
        };
      },
      grep: searchDetail(call("search")),
      lookup: searchDetail(call("lookup")),
      records: call("records", false, () => ({
        facets: { kinds: {}, origins: {} },
        records: [],
        total: 0,
        offset: 0,
        nextOffset: null,
        freshness: queryFreshness(now()),
      })),
      record: call("record"),
      ontology: call("ontology"),
      diagnostics: call("diagnostics", false, () => ({
        issues: [],
        total: 0,
        truncated: false,
        checkedAt: now(),
      })),
    };
  };

  const defaults = storeHandlers();
  // Operator-only proxy: run one ordinary operation against a selected agent's
  // effective store. Validates the inner input and output with the operation's
  // own schemas, and never serves agent tools.
  const proxy =
    (kind: "query" | "action") =>
    async (
      input: { agent: string; operation: string; input: unknown },
      context: FeatureInvocationContext,
    ) => {
      if (context.source !== "session-action") {
        throw operatorOnly();
      }
      // SAFETY: an unknown name reads undefined, which the membership check below rejects.
      const operation = contract.operations[input.operation as keyof StoreHandlers];
      if (!operation || !(input.operation in defaults) || operation.kind !== kind) {
        throw new Error(`Unknown ${kind} operation: ${input.operation}.`);
      }
      await stores.ensure();
      if (!stores.agents().includes(input.agent)) {
        throw new Error("Unknown agent.");
      }
      if (!Check(operation.input, input.input)) {
        throw new Error(`Invalid input for ${input.operation}.`);
      }
      // SAFETY: input.operation is a StoreHandlers key (checked above); input.input passed its own schema.
      const handler = storeHandlers(input.agent)[input.operation as keyof StoreHandlers] as (
        input: unknown,
        context: FeatureInvocationContext,
      ) => Promise<unknown>;
      const output = await handler(input.input, context);
      if (!Check(operation.output, output)) {
        throw new Error(`Invalid output from ${input.operation}.`);
      }
      return output;
    };
  // Operator inspection of the plugin-wide maintenance schedule and last pass.
  const maintenance_status = async (_: unknown, context: FeatureInvocationContext) => {
    if (
      context.source !== "session-action" ||
      !policy.operatorRead ||
      !context.action.client?.connId ||
      !context.action.client.scopes.some(
        (s) => s === "operator.read" || s === "operator.write" || s === "operator.admin",
      )
    ) {
      throw new Error("Maintenance status is available to authorized operators only.");
    }
    return maintenance.status();
  };
  return {
    ...defaults,
    ...createStoreOperations(stores),
    agent_query: proxy("query"),
    agent_action: proxy("action"),
    maintenance_status,
  };
}
