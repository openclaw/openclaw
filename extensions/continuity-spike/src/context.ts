import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export type ContextProfile = "shared" | "private" | "personal" | "ephemeral";
export type ContextPolicy = {
  id: string;
  sourceId: string;
  activityId: string;
  readers: string[];
  exportTo: string[];
  retain: boolean;
};
export type ContextProvenance = {
  recordId: string;
  policyId: string;
  sourceId: string;
  activityId: string;
  profile: ContextProfile;
};
export type ContextPayload = {
  id: string;
  text: string;
  profile: ContextProfile;
  provenance: ContextProvenance[];
};
type StoredRecord = ContextPayload & { activityId: string };
type Temporary = { activityId: string; expiresAt: number; assertCurrent: () => void };
type LiveRecord = StoredRecord & { temporaryId: string; requiresTemporary: string[] };

/** Host-owned, in-process access. JSON fields, tokens and boolean claims cannot create this. */
export type TemporaryViewCapability = {
  assertCurrent: () => void;
  read: () => string;
  close: () => void;
};
type PersonalView = Omit<LiveRecord, "text" | "requiresTemporary"> & {
  capability: TemporaryViewCapability;
};

const retainedKey = "context-records-v1";
const maxRecords = 128;
const maxSelection = 32;
const maxText = 4096;
const maxContextText = 16384;

function fail(reason: string): never {
  throw new Error(`continuity-context:${reason}`);
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-record");
  }
  // SAFETY: the preceding guard rejects null, arrays, and non-objects; fields are validated by callers.
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) {
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

function ids(value: unknown, limit = maxSelection): string[] {
  if (!Array.isArray(value) || value.length > limit) {
    fail("invalid-selection");
  }
  const result = value.map(id);
  if (new Set(result).size !== result.length) {
    fail("duplicate-selection");
  }
  return result;
}

function content(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxText) {
    fail("invalid-content");
  }
  return value;
}

function profile(value: unknown): ContextProfile {
  if (value !== "shared" && value !== "private" && value !== "personal" && value !== "ephemeral") {
    fail("invalid-profile");
  }
  return value;
}

function tag(value: unknown): ContextProvenance {
  const source = object(value, ["recordId", "policyId", "sourceId", "activityId", "profile"]);
  return {
    recordId: id(source.recordId),
    policyId: id(source.policyId),
    sourceId: id(source.sourceId),
    activityId: id(source.activityId),
    profile: profile(source.profile),
  };
}

function stored(value: unknown): StoredRecord {
  const source = object(value, ["id", "activityId", "text", "profile", "provenance"]);
  if (
    !Array.isArray(source.provenance) ||
    !source.provenance.length ||
    source.provenance.length > maxSelection
  ) {
    fail("invalid-provenance");
  }
  return {
    id: id(source.id),
    activityId: id(source.activityId),
    text: content(source.text),
    profile: profile(source.profile),
    provenance: source.provenance.map(tag),
  };
}

function retained(value: unknown): StoredRecord[] {
  if (value === undefined) {
    return [];
  }
  const root = object(value, ["records"]);
  if (!Array.isArray(root.records) || root.records.length > maxRecords) {
    fail("invalid-store");
  }
  const records = root.records.map(stored);
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    fail("invalid-store");
  }
  for (const record of records) {
    if (record.profile !== "shared" && record.profile !== "private") {
      fail("invalid-retained-profile");
    }
    if (
      record.provenance.some(
        (source) => source.profile === "personal" || source.activityId !== record.activityId,
      )
    ) {
      fail("invalid-retained-provenance");
    }
  }
  return records;
}

/**
 * Experimental context owner, not a vault or transcript eraser. Policies and enrollment
 * are host authority; callers must not expose addRecord/saveSelected as agent tools.
 * Logical purge invalidates this module's references, not strings already exported to a
 * model, native thread, tool, log, provider or backup. Personal integration needs those
 * host guarantees before it can be enabled outside a synthetic capability harness.
 */
export function createScopedContext(options: {
  store: PluginStateSyncKeyedStore<unknown>;
  localRecipientId: string;
  policy: (policyId: string) => ContextPolicy | undefined;
  canImport: (scope: { sourceId: string; recipientId: string; activityId: string }) => boolean;
  now?: () => number;
}) {
  const update = options.store.update?.bind(options.store);
  if (!update) {
    fail("atomic-store-update-unavailable");
  }
  const now = options.now ?? Date.now;
  const localRecipientId = id(options.localRecipientId);
  const temporary = new Map<string, Temporary>();
  const live = new Map<string, LiveRecord>();
  const personal = new Map<string, PersonalView>();

  function policy(policyId: string): ContextPolicy {
    const raw = options.policy(policyId);
    if (!raw) {
      fail("unknown-policy");
    }
    const candidate = object(raw, [
      "id",
      "sourceId",
      "activityId",
      "readers",
      "exportTo",
      "retain",
    ]);
    if (candidate.id !== policyId || typeof candidate.retain !== "boolean") {
      fail("invalid-policy");
    }
    return {
      id: id(candidate.id),
      sourceId: id(candidate.sourceId),
      activityId: id(candidate.activityId),
      readers: ids(candidate.readers),
      exportTo: ids(candidate.exportTo),
      retain: candidate.retain,
    };
  }

  function governing(source: ContextProvenance): ContextPolicy {
    const current = policy(source.policyId);
    if (current.sourceId !== source.sourceId || current.activityId !== source.activityId) {
      fail("policy-identity-changed");
    }
    return current;
  }

  function endTemporary(temporaryId: string): void {
    id(temporaryId);
    temporary.delete(temporaryId);
    for (const [recordId, record] of live) {
      if (record.temporaryId === temporaryId || record.requiresTemporary.includes(temporaryId)) {
        live.delete(recordId);
      }
    }
    for (const [recordId, record] of personal) {
      if (record.temporaryId === temporaryId) {
        personal.delete(recordId);
        try {
          record.capability.close();
        } catch {
          // The reference is already gone. Host context retirement remains its obligation.
        }
      }
    }
  }

  function currentTemporary(temporaryId: string, activityId: string): Temporary {
    const current = temporary.get(temporaryId);
    if (!current || current.activityId !== activityId) {
      fail("temporary-context-unavailable");
    }
    try {
      if (now() >= current.expiresAt) {
        fail("temporary-context-expired");
      }
      current.assertCurrent();
      if (temporary.get(temporaryId) !== current || now() >= current.expiresAt) {
        fail("temporary-context-expired-or-replaced");
      }
    } catch {
      endTemporary(temporaryId);
      fail("temporary-context-unavailable");
    }
    return current;
  }

  function sweep(): void {
    for (const [temporaryId, scope] of temporary) {
      try {
        currentTemporary(temporaryId, scope.activityId);
      } catch {
        // Reads cannot revive expired/revoked side conversations.
      }
    }
  }

  function currentPersonal(view: PersonalView): void {
    try {
      currentTemporary(view.temporaryId, view.activityId);
      view.capability.assertCurrent();
    } catch {
      endTemporary(view.temporaryId);
      fail("personal-view-unavailable");
    }
  }

  function read(recordId: string, materializePersonal = false): StoredRecord {
    const record = live.get(recordId);
    if (record) {
      currentTemporary(record.temporaryId, record.activityId);
      for (const dependency of record.requiresTemporary) {
        currentTemporary(dependency, record.activityId);
      }
      return structuredClone({
        id: record.id,
        activityId: record.activityId,
        text: record.text,
        profile: record.profile,
        provenance: record.provenance,
      });
    }
    const view = personal.get(recordId);
    if (view) {
      currentPersonal(view);
      const text = materializePersonal
        ? content(view.capability.read())
        : "[protected temporary view]";
      currentPersonal(view);
      return {
        id: view.id,
        activityId: view.activityId,
        text,
        profile: "personal",
        provenance: structuredClone(view.provenance),
      };
    }
    return (
      retained(options.store.lookup(retainedKey)).find((entry) => entry.id === recordId) ??
      fail("record-unavailable")
    );
  }

  function check(
    record: StoredRecord,
    recipientId: string,
    activityId: string,
    verifyPersonal = true,
  ): void {
    if (record.activityId !== activityId) {
      fail("activity-denied");
    }
    for (const source of record.provenance) {
      const rule = governing(source);
      if (source.activityId !== activityId || !rule.readers.includes(recipientId)) {
        fail("audience-denied");
      }
      if (rule.sourceId !== recipientId && !rule.exportTo.includes(recipientId)) {
        fail("export-denied");
      }
      if (!options.canImport({ sourceId: rule.sourceId, recipientId, activityId })) {
        fail("import-denied");
      }
      if (verifyPersonal && source.profile === "personal") {
        const view = personal.get(source.recordId);
        if (!view) {
          fail("personal-view-unavailable");
        }
        currentPersonal(view);
      }
    }
  }

  function save(records: StoredRecord[], assertCurrent: () => void): void {
    if (!update) {
      fail("atomic-store-update-unavailable");
    }
    const completion: { validationFailure?: { error: unknown } } = {};
    const committed = update(retainedKey, (value) => {
      try {
        const current = retained(value);
        // Authorization and source lifetime belong to this synchronous commit, not
        // only to the preparation that selected the records.
        assertCurrent();
        if (
          current.length + records.length > maxRecords ||
          records.some((record) => current.some((entry) => entry.id === record.id))
        ) {
          fail("record-limit-or-duplicate");
        }
        return { records: [...current, ...structuredClone(records)] };
      } catch (error) {
        // Preserve domain denial/conflict outside the native storage-error wrapper.
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

  function ownTag(
    source: Record<string, unknown>,
    requestedProfile: ContextProfile,
  ): ContextProvenance {
    const rule = policy(id(source.policyId));
    const activityId = id(source.activityId);
    if (rule.activityId !== activityId) {
      fail("activity-denied");
    }
    return {
      recordId: id(source.id),
      policyId: rule.id,
      sourceId: rule.sourceId,
      activityId,
      profile: requestedProfile,
    };
  }

  function unique(recordId: string): void {
    if (
      live.has(recordId) ||
      personal.has(recordId) ||
      retained(options.store.lookup(retainedKey)).some((record) => record.id === recordId)
    ) {
      fail("duplicate-record");
    }
  }

  return {
    beginTemporary(value: unknown, assertCurrent: () => void = () => {}) {
      sweep();
      const input = object(value, ["id", "activityId", "expiresAt"]);
      const temporaryId = id(input.id);
      if (
        temporary.has(temporaryId) ||
        temporary.size >= 16 ||
        typeof input.expiresAt !== "number" ||
        !Number.isFinite(input.expiresAt) ||
        input.expiresAt <= now() ||
        input.expiresAt > now() + 3600000
      ) {
        fail("invalid-temporary-scope");
      }
      assertCurrent();
      temporary.set(temporaryId, {
        activityId: id(input.activityId),
        expiresAt: input.expiresAt,
        assertCurrent,
      });
    },

    addRecord(value: unknown) {
      sweep();
      const input = object(value, [
        "id",
        "activityId",
        "policyId",
        "profile",
        "text",
        "derivedFrom",
        "temporaryId",
      ]);
      const requestedProfile = profile(input.profile);
      if (requestedProfile === "personal") {
        fail("personal-requires-host-capability");
      }
      const own = ownTag(input, requestedProfile);
      unique(own.recordId);
      const derivedFrom = ids(input.derivedFrom ?? []);
      const derivedRecords = derivedFrom.map((recordId) => read(recordId));
      const ancestors = derivedRecords.flatMap((source) => source.provenance);
      const bindings = new Map<string, ContextProvenance>();
      for (const source of [own, ...ancestors]) {
        const existing = bindings.get(source.recordId);
        if (
          existing &&
          (existing.policyId !== source.policyId ||
            existing.sourceId !== source.sourceId ||
            existing.activityId !== source.activityId ||
            existing.profile !== source.profile)
        ) {
          fail("provenance-identity-conflict");
        }
        bindings.set(source.recordId, source);
      }
      const provenance = [...bindings.values()];
      if (
        provenance.length > maxSelection ||
        provenance.some((source) => source.activityId !== own.activityId)
      ) {
        fail("invalid-provenance");
      }
      const record: StoredRecord = {
        id: own.recordId,
        activityId: own.activityId,
        profile: requestedProfile,
        text: content(input.text),
        provenance,
      };
      check(record, localRecipientId, own.activityId);
      if (requestedProfile === "ephemeral") {
        const temporaryId = id(input.temporaryId);
        currentTemporary(temporaryId, own.activityId);
        if (live.size + personal.size >= maxRecords) {
          fail("temporary-record-limit");
        }
        const dependencies = derivedFrom.flatMap((recordId) => {
          const liveSource = live.get(recordId);
          if (liveSource) {
            return [liveSource.temporaryId, ...liveSource.requiresTemporary];
          }
          const personalSource = personal.get(recordId);
          return personalSource ? [personalSource.temporaryId] : [];
        });
        live.set(record.id, {
          ...record,
          temporaryId,
          requiresTemporary: [...new Set(dependencies)],
        });
      } else {
        if (
          input.temporaryId !== undefined ||
          derivedFrom.some((recordId) => live.has(recordId)) ||
          provenance.some((source) => source.profile === "personal" || !governing(source).retain)
        ) {
          fail("retention-denied-use-explicit-save");
        }
        save([record], () => {
          unique(record.id);
          for (const source of derivedRecords) {
            if (JSON.stringify(read(source.id)) !== JSON.stringify(source)) {
              fail("context-record-changed");
            }
          }
          check(record, localRecipientId, own.activityId);
          if (
            derivedFrom.some((recordId) => live.has(recordId)) ||
            record.provenance.some(
              (source) => source.profile === "personal" || !governing(source).retain,
            )
          ) {
            fail("retention-denied-use-explicit-save");
          }
        });
      }
      return { id: record.id, profile: record.profile };
    },

    attachPersonalView(value: unknown, capability: TemporaryViewCapability) {
      sweep();
      const input = object(value, ["id", "activityId", "policyId", "temporaryId"]);
      if (
        !capability ||
        typeof capability.assertCurrent !== "function" ||
        typeof capability.read !== "function" ||
        typeof capability.close !== "function"
      ) {
        fail("personal-requires-host-capability");
      }
      const own = ownTag(input, "personal");
      unique(own.recordId);
      const temporaryId = id(input.temporaryId);
      currentTemporary(temporaryId, own.activityId);
      capability.assertCurrent();
      check(
        {
          id: own.recordId,
          activityId: own.activityId,
          profile: "personal",
          text: "[protected temporary view]",
          provenance: [own],
        },
        localRecipientId,
        own.activityId,
        false,
      );
      if (live.size + personal.size >= maxRecords) {
        fail("temporary-record-limit");
      }
      personal.set(own.recordId, {
        id: own.recordId,
        activityId: own.activityId,
        profile: "personal",
        temporaryId,
        provenance: [own],
        capability,
      });
    },

    requestContext(value: unknown): ContextPayload[] {
      sweep();
      const input = object(value, ["activityId", "recipientId", "recordIds"]);
      const activityId = id(input.activityId);
      const recipientId = id(input.recipientId);
      const selected = ids(input.recordIds);
      const metadata = selected.map((recordId) => read(recordId));
      for (const record of metadata) {
        check(record, recipientId, activityId);
      }
      const records = selected.map((recordId) => read(recordId, true));
      for (const record of records) {
        check(record, recipientId, activityId);
      }
      if (records.reduce((length, record) => length + record.text.length, 0) > maxContextText) {
        fail("context-limit");
      }
      return records.map(({ id: recordId, text, profile: recordProfile, provenance }) => ({
        id: recordId,
        text,
        profile: recordProfile,
        provenance: structuredClone(provenance),
      }));
    },

    saveSelected(value: unknown): { savedIds: string[]; omittedCount: number } {
      sweep();
      const input = object(value, [
        "temporaryId",
        "recipientId",
        "recordIds",
        "wholeConversation",
        "profile",
      ]);
      const temporaryId = id(input.temporaryId);
      const scope = temporary.get(temporaryId) ?? fail("temporary-context-unavailable");
      currentTemporary(temporaryId, scope.activityId);
      const recipientId = id(input.recipientId);
      const targetProfile = profile(input.profile);
      if (targetProfile !== "shared" && targetProfile !== "private") {
        fail("invalid-save-profile");
      }
      if (
        (input.wholeConversation !== undefined && input.wholeConversation !== true) ||
        (input.wholeConversation === true) === (input.recordIds !== undefined)
      ) {
        fail("choose-exact-selection-or-conversation");
      }
      const conversation = [...live.values(), ...personal.values()].filter(
        (record) => record.temporaryId === temporaryId,
      );
      const selected =
        input.wholeConversation === true
          ? conversation.map((record) => record.id)
          : ids(input.recordIds);
      if (!selected.length || selected.length > maxSelection) {
        fail("invalid-selection");
      }
      const records: StoredRecord[] = [];
      const retainedSources: string[] = [];
      let omittedCount = 0;
      for (const recordId of selected) {
        try {
          if (!conversation.some((record) => record.id === recordId)) {
            fail("selection-not-in-conversation");
          }
          const record = read(recordId);
          check(record, localRecipientId, scope.activityId);
          check(record, recipientId, scope.activityId);
          if (
            record.provenance.some(
              (source) => source.profile === "personal" || !governing(source).retain,
            )
          ) {
            fail("retention-denied");
          }
          const savedId = id(`saved:${record.id}`);
          unique(savedId);
          records.push({ ...record, id: savedId, profile: targetProfile });
          retainedSources.push(recordId);
        } catch (error) {
          if (input.wholeConversation !== true) {
            throw error;
          }
          omittedCount++;
        }
      }
      const assertCurrent = () => {
        // Eligibility omissions cannot conceal a closed/replaced conversation,
        // changed source, or permission lost while entering the native updater.
        if (currentTemporary(temporaryId, scope.activityId) !== scope) {
          fail("temporary-context-changed");
        }
        const currentRecords = retainedSources.map((recordId) => {
          const record = read(recordId);
          check(record, localRecipientId, scope.activityId);
          check(record, recipientId, scope.activityId);
          if (
            record.provenance.some(
              (source) => source.profile === "personal" || !governing(source).retain,
            )
          ) {
            fail("retention-denied");
          }
          const savedId = id(`saved:${record.id}`);
          unique(savedId);
          return Object.assign({}, record, { id: savedId, profile: targetProfile });
        });
        if (JSON.stringify(currentRecords) !== JSON.stringify(records)) {
          fail("context-record-changed");
        }
        if (currentTemporary(temporaryId, scope.activityId) !== scope) {
          fail("temporary-context-changed");
        }
      };
      if (records.length) {
        save(records, assertCurrent);
      } else {
        assertCurrent();
      }
      return { savedIds: records.map((record) => record.id), omittedCount };
    },

    endTemporary,
  };
}
