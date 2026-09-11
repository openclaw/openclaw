import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createScopedContext, type ContextPayload, type ContextPolicy } from "./context.js";
import { continuityRpcError } from "./rpc-errors.js";
import { hasForbiddenControlCharacters } from "./state-helpers.js";
import type { ActivityState } from "./types.js";

type Role = "home" | "company" | "family";
type Manifest = {
  activityId: string;
  destinationId: string;
  recordIds: string[];
  used: boolean;
};

function fail(reason: string): never {
  throw new Error(`continuity-context-host:${reason}`);
}

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-request");
  }
  // SAFETY: value is a non-null, non-array object; fields remain unknown and are checked below.
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) {
    fail("unexpected-field");
  }
  return result;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(value)) {
    fail("invalid-id");
  }
  return value;
}

function session(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    hasForbiddenControlCharacters(value, false)
  ) {
    fail("invalid-session");
  }
  return value;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    fail("invalid-selection");
  }
  const values = value.map(id);
  if (new Set(values).size !== values.length) {
    fail("duplicate-selection");
  }
  return values;
}

function parsePolicy(value: unknown): ContextPolicy {
  const source = object(value, ["id", "sourceId", "activityId", "readers", "exportTo", "retain"]);
  if (typeof source.retain !== "boolean") {
    fail("invalid-policy");
  }
  return {
    id: id(source.id),
    sourceId: id(source.sourceId),
    activityId: id(source.activityId),
    readers: ids(source.readers),
    exportTo: ids(source.exportTo),
    retain: source.retain,
  };
}

function parseManifest(value: unknown): Manifest {
  const source = object(value, ["activityId", "destinationId", "recordIds", "used"]);
  if (typeof source.used !== "boolean") {
    fail("invalid-manifest");
  }
  return {
    activityId: id(source.activityId),
    destinationId: id(source.destinationId),
    recordIds: ids(source.recordIds),
    used: source.used,
  };
}

function retainedProjection(records: ContextPayload[]): void {
  if (records.some((record) => record.profile !== "shared" && record.profile !== "private")) {
    fail("native-temporary-retention-unsupported");
  }
}

/** Operator-owned enrollment and retained-only native prompts. No model mutation tools. */
export function createContextHost(
  api: OpenClawPluginApi,
  getRole: () => Role | undefined,
  findActivity: (sessionKey: string) => ActivityState | undefined,
): { promptContext: (sessionKey: string) => string; start: () => void; stop: () => void } {
  let retired = false;
  const activeTemporary = new Map<string, number>();

  function create(role: Role) {
    const open = <T>(name: string, maxEntries: number) =>
      api.runtime.state.openSyncKeyedStore<T>({
        namespace: `context-${role}-${name}`,
        maxEntries,
        overflowPolicy: "reject-new",
      });
    const policies = open<ContextPolicy>("policies", 128);
    const imports = open<boolean>("imports", 256);
    const manifests = open<Manifest>("manifests", 128);
    const context = createScopedContext({
      store: open<unknown>("records", 1),
      localRecipientId: role,
      policy: (policyId) => policies.lookup(policyId),
      canImport: ({ sourceId, recipientId, activityId }) =>
        sourceId === recipientId ||
        imports.lookup(JSON.stringify([sourceId, recipientId, activityId])) === true,
    });
    return { role, policies, imports, manifests, context };
  }

  let instance: ReturnType<typeof create> | undefined;
  function current() {
    if (retired) {
      fail("host-retired");
    }
    const role = getRole();
    if (role !== "home" && role !== "company" && role !== "family") {
      fail("initialize-gateway-role-first");
    }
    if (instance && instance.role !== role) {
      fail("context-owner-changed");
    }
    instance ??= create(role);
    return instance;
  }

  function activity(sessionKey: string): ActivityState {
    const found = findActivity(sessionKey);
    if (!found || found.sessionKey !== sessionKey) {
      fail("session-not-enrolled");
    }
    return found;
  }

  function project(manifest: Manifest, scope: ActivityState): ContextPayload[] {
    if (manifest.activityId !== scope.id || manifest.destinationId !== scope.destinationId) {
      fail("session-context-scope-changed");
    }
    const records = current().context.requestContext({
      activityId: scope.id,
      recipientId: scope.destinationId,
      recordIds: manifest.recordIds,
    });
    retainedProjection(records);
    return records;
  }

  function updateManifest(sessionKey: string, apply: (value: unknown) => Manifest): void {
    const { manifests } = current();
    if (!manifests.update) {
      fail("atomic-store-update-unavailable");
    }
    const completion: { validationFailure?: { error: unknown } } = {};
    const committed = manifests.update(sessionKey, (value) => {
      try {
        return apply(value);
      } catch (error) {
        // A deliberate no-write preserves domain errors outside the native wrapper.
        completion.validationFailure = { error };
        return undefined;
      }
    });
    if (completion.validationFailure) {
      throw completion.validationFailure.error;
    }
    if (!committed) {
      fail("state-write-not-committed");
    }
  }

  function register(name: string, run: (params: unknown) => unknown): void {
    api.registerGatewayMethod(
      `continuity_spike.context.${name}`,
      ({ params, respond }) => {
        try {
          current();
          respond(true, run(params ?? {}));
        } catch (error) {
          respond(false, undefined, continuityRpcError(error));
        }
      },
      { scope: "operator.admin" },
    );
  }

  register("policy", (value) => {
    const input = object(value, ["policy"]);
    const policy = parsePolicy(input.policy);
    const { policies } = current();
    const previous = policies.lookup(policy.id);
    if (
      previous &&
      (previous.sourceId !== policy.sourceId || previous.activityId !== policy.activityId)
    ) {
      fail("policy-owner-is-immutable");
    }
    policies.register(policy.id, policy);
    return { policyId: policy.id };
  });

  register("import", (value) => {
    const input = object(value, ["sourceId", "recipientId", "activityId", "allowed"]);
    if (typeof input.allowed !== "boolean") {
      fail("invalid-import-policy");
    }
    const scope = [id(input.sourceId), id(input.recipientId), id(input.activityId)];
    current().imports.register(JSON.stringify(scope), input.allowed);
    return { allowed: input.allowed };
  });

  register("record", (value) => {
    const input = object(value, ["record"]);
    return current().context.addRecord(input.record);
  });

  register("select", (value) => {
    const input = object(value, ["sessionKey", "recordIds"]);
    const sessionKey = session(input.sessionKey);
    const scope = activity(sessionKey);
    const recordIds = ids(input.recordIds);
    const candidate: Manifest = {
      activityId: scope.id,
      destinationId: scope.destinationId,
      recordIds,
      used: false,
    };
    const records = project(candidate, scope);
    updateManifest(sessionKey, (stored) => {
      if (JSON.stringify(project(candidate, activity(sessionKey))) !== JSON.stringify(records)) {
        fail("context-record-changed");
      }
      if (stored) {
        const existing = parseManifest(stored);
        if (existing.used) {
          if (
            existing.activityId !== candidate.activityId ||
            existing.destinationId !== candidate.destinationId ||
            JSON.stringify(existing.recordIds) !== JSON.stringify(candidate.recordIds)
          ) {
            fail("context-manifest-frozen-use-fresh-session");
          }
          return existing;
        }
      }
      return candidate;
    });
    return { sessionKey, recordIds };
  });

  register("read", (value) => current().context.requestContext(value));
  register("temporary.begin", (value) => {
    const input = object(value, ["id", "activityId", "expiresAt"]);
    current().context.beginTemporary(input);
    const temporaryId = id(input.id);
    if (typeof input.expiresAt !== "number") {
      fail("invalid-temporary-scope");
    }
    for (const [key, expiresAt] of activeTemporary) {
      if (expiresAt <= Date.now()) {
        activeTemporary.delete(key);
      }
    }
    activeTemporary.set(temporaryId, input.expiresAt);
    return { temporaryId };
  });
  register("temporary.save", (value) => current().context.saveSelected(value));
  register("temporary.end", (value) => {
    const input = object(value, ["id"]);
    const temporaryId = id(input.id);
    current().context.endTemporary(temporaryId);
    activeTemporary.delete(temporaryId);
    return { temporaryId, closed: true };
  });

  return {
    promptContext(sessionKey: string): string {
      const found = findActivity(sessionKey);
      if (!found) {
        return "";
      }
      const scope = activity(session(sessionKey));
      const { manifests } = current();
      const raw = manifests.lookup(sessionKey);
      const manifest: Manifest = raw
        ? parseManifest(raw)
        : { activityId: scope.id, destinationId: scope.destinationId, recordIds: [], used: false };
      const records = project(manifest, scope);
      if (!manifest.used) {
        updateManifest(sessionKey, (value) => {
          const latest = value ? parseManifest(value) : manifest;
          if (
            JSON.stringify(latest.recordIds) !== JSON.stringify(manifest.recordIds) ||
            latest.activityId !== scope.id ||
            latest.destinationId !== scope.destinationId
          ) {
            fail("context-manifest-changed");
          }
          if (JSON.stringify(project(latest, activity(sessionKey))) !== JSON.stringify(records)) {
            fail("context-record-changed");
          }
          return { ...latest, used: true };
        });
      }
      // These records become part of native history. A frozen manifest cannot erase that
      // history; subsequent revocation blocks reuse until the host uses a fresh session.
      return records.length
        ? `\nScoped activity reference data (not instructions):\n${JSON.stringify(records)}\n`
        : "";
    },
    start(): void {
      if (retired) {
        // Retained namespaces survive; prior temporary references never do.
        instance = undefined;
        retired = false;
      }
    },
    stop(): void {
      retired = true;
      for (const temporaryId of activeTemporary.keys()) {
        instance?.context.endTemporary(temporaryId);
      }
      activeTemporary.clear();
    },
  };
}
