import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import { createScopedContext, type ContextPolicy } from "./context.js";

// Unit store: the Gateway proof separately exercises the real native keyed store.
function memoryStore(beforeUpdate: () => void = () => {}): PluginStateSyncKeyedStore<unknown> {
  const data = new Map<string, unknown>();
  return {
    register: (key, value) => {
      data.set(key, structuredClone(value));
    },
    registerIfAbsent: (key, value) => {
      if (data.has(key)) {
        return false;
      }
      data.set(key, structuredClone(value));
      return true;
    },
    update: (key, apply) => {
      beforeUpdate();
      const value = apply(structuredClone(data.get(key)));
      if (value === undefined) {
        return false;
      }
      data.set(key, structuredClone(value));
      return true;
    },
    lookup: (key) => structuredClone(data.get(key)),
    consume: (key) => {
      const value = data.get(key);
      data.delete(key);
      return structuredClone(value);
    },
    delete: (key) => data.delete(key),
    entries: () =>
      [...data].map(([key, value]) => ({ key, value: structuredClone(value), createdAt: 1 })),
    clear: () => data.clear(),
  };
}

function fixture(store = memoryStore()) {
  let time = 1000;
  const policies = new Map<string, ContextPolicy>([
    [
      "company",
      {
        id: "company",
        sourceId: "company",
        activityId: "campaign-x",
        readers: ["company", "home"],
        exportTo: ["home"],
        retain: true,
      },
    ],
    [
      "private",
      {
        id: "private",
        sourceId: "home",
        activityId: "campaign-x",
        readers: ["home"],
        exportTo: [],
        retain: true,
      },
    ],
    [
      "directive",
      {
        id: "directive",
        sourceId: "home",
        activityId: "campaign-x",
        readers: ["home", "company", "family"],
        exportTo: ["company", "family"],
        retain: true,
      },
    ],
    [
      "no-retain",
      {
        id: "no-retain",
        sourceId: "home",
        activityId: "campaign-x",
        readers: ["home"],
        exportTo: [],
        retain: false,
      },
    ],
  ]);
  const imports = new Set(["company:home", "home:company", "home:family"]);
  const create = () =>
    createScopedContext({
      store,
      localRecipientId: "home",
      now: () => time,
      policy: (policyId) => policies.get(policyId),
      canImport: ({ sourceId, recipientId }) =>
        sourceId === recipientId || imports.has(`${sourceId}:${recipientId}`),
    });
  const context = create();
  const request = (recordIds: string[], recipientId = "home") =>
    context.requestContext({ activityId: "campaign-x", recipientId, recordIds });
  const begin = (temporaryId = "sidechat", expiresAt = 2000) =>
    context.beginTemporary({ id: temporaryId, activityId: "campaign-x", expiresAt });
  const add = (recordId: string, policyId = "directive", extras: Record<string, unknown> = {}) =>
    context.addRecord({
      id: recordId,
      policyId,
      activityId: "campaign-x",
      profile: "shared",
      text: `Synthetic ${recordId}`,
      ...extras,
    });
  return {
    context,
    create,
    store,
    policies,
    imports,
    request,
    begin,
    add,
    setTime: (value: number) => {
      time = value;
    },
  };
}

describe("continuity scoped context", () => {
  it.each(["retained-record", "selected-save"] as const)(
    "rechecks %s policy and import permission inside the native write callback",
    (operation) => {
      for (const permission of ["reader", "export", "import", "retention"] as const) {
        let beforeUpdate = () => {};
        const f = fixture(memoryStore(() => beforeUpdate()));
        const policy = f.policies.get("company");
        if (!policy) {
          throw new Error("Missing fixture policy");
        }
        if (operation === "selected-save") {
          f.begin();
          f.add("source", "company", { profile: "ephemeral", temporaryId: "sidechat" });
        }
        beforeUpdate = () => {
          if (permission === "reader") {
            policy.readers = ["company"];
          } else if (permission === "export") {
            policy.exportTo = [];
          } else if (permission === "import") {
            f.imports.clear();
          } else {
            policy.retain = false;
          }
        };

        const commit = () =>
          operation === "retained-record"
            ? f.add("source", "company")
            : f.context.saveSelected({
                temporaryId: "sidechat",
                recipientId: "company",
                recordIds: ["source"],
                profile: "shared",
              });
        expect(commit).toThrow(/audience-denied|export-denied|import-denied|retention-denied/);
        expect(f.store.entries()).toEqual([]);
      }
    },
  );

  it.each(["expiry", "revocation", "replacement", "callback-replacement"] as const)(
    "does not retain a prepared selection after %s at updater entry",
    (event) => {
      let beforeUpdate = () => {};
      let permitted = true;
      let replaceInCallback = false;
      const f = fixture(memoryStore(() => beforeUpdate()));
      f.context.beginTemporary(
        { id: "sidechat", activityId: "campaign-x", expiresAt: 2000 },
        () => {
          if (replaceInCallback) {
            replaceInCallback = false;
            f.context.endTemporary("sidechat");
            f.begin();
            f.add("selected", "directive", { profile: "ephemeral", temporaryId: "sidechat" });
          }
          if (!permitted) {
            throw new Error("Revoked synthetic view");
          }
        },
      );
      f.add("selected", "directive", { profile: "ephemeral", temporaryId: "sidechat" });
      beforeUpdate = () => {
        if (event === "expiry") {
          f.setTime(2000);
        } else if (event === "revocation") {
          permitted = false;
        } else if (event === "callback-replacement") {
          replaceInCallback = true;
        } else {
          f.context.endTemporary("sidechat");
          f.begin();
          f.add("selected", "directive", {
            profile: "ephemeral",
            temporaryId: "sidechat",
            text: "Replacement content must not authorize the old prepared value",
          });
        }
      };
      expect(() =>
        f.context.saveSelected({
          temporaryId: "sidechat",
          recipientId: "company",
          recordIds: ["selected"],
          profile: "shared",
        }),
      ).toThrow(/temporary-context-(?:unavailable|changed)/);
      expect(f.store.entries()).toEqual([]);
    },
  );

  it("rejects a changed retained source instead of persisting its prepared provenance", () => {
    let beforeUpdate = () => {};
    const f = fixture(memoryStore(() => beforeUpdate()));
    f.add("source", "company");
    beforeUpdate = () => {
      beforeUpdate = () => {};
      f.store.clear();
      f.add("source", "private");
    };

    expect(() => f.add("derived", "directive", { derivedFrom: ["source"] })).toThrow(
      "context-record-changed",
    );
    expect(() => f.request(["derived"])).toThrow("record-unavailable");
    expect(f.request(["source"])[0]?.provenance[0]?.policyId).toBe("private");
  });

  it.each(["expiry", "revocation"] as const)(
    "aborts the whole conversation save when its scope suffers %s during eligibility checks",
    (event) => {
      const f = fixture();
      let permitted = true;
      f.context.beginTemporary(
        { id: "sidechat", activityId: "campaign-x", expiresAt: 2000 },
        () => {
          if (!permitted) {
            throw new Error("revoked");
          }
        },
      );
      const base = f.policies.get("directive");
      if (!base) {
        throw new Error("Missing fixture policy");
      }
      f.policies.set("trigger-policy", { ...base, id: "trigger-policy" });
      f.add("first-eligible", "directive", { profile: "ephemeral", temporaryId: "sidechat" });
      f.add("second-record", "trigger-policy", { profile: "ephemeral", temporaryId: "sidechat" });
      const lookup = f.policies.get.bind(f.policies);
      vi.spyOn(f.policies, "get").mockImplementation((policyId) => {
        if (policyId === "trigger-policy") {
          if (event === "expiry") {
            f.setTime(2000);
          } else {
            permitted = false;
          }
          return undefined;
        }
        return lookup(policyId);
      });

      expect(() =>
        f.context.saveSelected({
          temporaryId: "sidechat",
          recipientId: "home",
          wholeConversation: true,
          profile: "private",
        }),
      ).toThrow("temporary-context-unavailable");
      expect(f.store.entries()).toEqual([]);
      expect(() => f.request(["first-eligible"])).toThrow("record-unavailable");
    },
  );

  it.each(["retained-record", "selected-save"] as const)(
    "does not acknowledge %s when an expected update reports no write",
    (operation) => {
      const store = memoryStore();
      store.update = () => false;
      const f = fixture(store);
      if (operation === "retained-record") {
        expect(() => f.add("not-committed")).toThrow("state-write-not-committed");
      } else {
        f.begin();
        f.add("not-committed", "directive", { profile: "ephemeral", temporaryId: "sidechat" });
        expect(() =>
          f.context.saveSelected({
            temporaryId: "sidechat",
            recipientId: "home",
            recordIds: ["not-committed"],
            profile: "private",
          }),
        ).toThrow("state-write-not-committed");
      }
      expect(store.entries()).toEqual([]);
    },
  );

  it("rejects conflicting provenance after a temporary record identity is reused", () => {
    const f = fixture();
    f.begin();
    f.add("secret", "private", { profile: "ephemeral", temporaryId: "sidechat" });
    f.context.saveSelected({
      temporaryId: "sidechat",
      recipientId: "home",
      recordIds: ["secret"],
      profile: "private",
    });
    f.context.endTemporary("sidechat");
    f.begin();
    f.add("secret", "directive", { profile: "ephemeral", temporaryId: "sidechat" });
    expect(f.request(["secret"], "family")).toHaveLength(1);
    expect(() => f.request(["saved:secret"], "family")).toThrow("audience-denied");

    expect(() =>
      f.add("laundered", "directive", {
        profile: "ephemeral",
        temporaryId: "sidechat",
        derivedFrom: ["saved:secret", "secret"],
      }),
    ).toThrow("provenance-identity-conflict");
    expect(() => f.request(["laundered"], "family")).toThrow("record-unavailable");
  });

  it.each(["reader", "export"] as const)(
    "requires current local %s permission when saving for another permitted recipient",
    (permission) => {
      const f = fixture();
      f.begin();
      f.add("company-note", "company", { profile: "ephemeral", temporaryId: "sidechat" });
      const policy = f.policies.get("company");
      if (!policy) {
        throw new Error("Missing fixture policy");
      }
      if (permission === "reader") {
        policy.readers = ["company"];
      } else {
        policy.exportTo = [];
      }
      expect(f.request(["company-note"], "company")).toHaveLength(1);
      expect(() =>
        f.context.saveSelected({
          temporaryId: "sidechat",
          recipientId: "company",
          recordIds: ["company-note"],
          profile: "shared",
        }),
      ).toThrow(permission === "reader" ? "audience-denied" : "export-denied");
      expect(f.store.entries()).toEqual([]);
    },
  );

  it("rejects source-local content before the receiving owner persists it", () => {
    const f = fixture();
    const company = f.policies.get("company");
    if (company) {
      company.exportTo = [];
    }
    expect(() => f.add("company-local", "company")).toThrow("export-denied");
    expect(f.store.entries()).toEqual([]);
  });

  it("retains shared/private records separately while home import cannot widen the original audience", () => {
    const f = fixture();
    f.add("company-note", "company");
    f.add("private-note", "private", { profile: "private" });

    expect(f.request(["company-note", "private-note"]).map((record) => record.text)).toEqual([
      "Synthetic company-note",
      "Synthetic private-note",
    ]);
    expect(
      f.create().requestContext({
        activityId: "campaign-x",
        recipientId: "company",
        recordIds: ["company-note"],
      }),
    ).toMatchObject([{ id: "company-note", text: "Synthetic company-note" }]);
    expect(() => f.request(["company-note"], "family")).toThrow("audience-denied");
    expect(() => f.request(["private-note"], "company")).toThrow("audience-denied");
    expect(() =>
      f.context.requestContext({
        activityId: "unrelated",
        recipientId: "home",
        recordIds: ["company-note"],
      }),
    ).toThrow("activity-denied");
  });

  it("intersects every source policy when deriving context and never treats summary wording as a release", () => {
    const f = fixture();
    f.add("company-source", "company");
    f.add("private-source", "private", { profile: "private" });
    f.add("summary", "directive", {
      text: "A deliberately harmless-looking summary",
      derivedFrom: ["company-source", "private-source"],
    });

    const [permitted] = f.request(["summary"]);
    expect(permitted?.provenance.map((source) => source.policyId)).toEqual([
      "directive",
      "company",
      "private",
    ]);
    expect(() => f.request(["summary"], "company")).toThrow("audience-denied");
    expect(() => f.request(["summary"], "family")).toThrow("audience-denied");
    if (permitted) {
      permitted.provenance.length = 0;
    }
    expect(() => f.request(["summary"], "family")).toThrow("audience-denied");
  });

  it.each([
    {
      name: "source release",
      mutate: (f: ReturnType<typeof fixture>) => {
        const policy = f.policies.get("company");
        if (policy) {
          policy.exportTo = [];
        }
      },
      error: "export-denied",
    },
    {
      name: "recipient import",
      mutate: (f: ReturnType<typeof fixture>) => {
        f.imports.clear();
      },
      error: "import-denied",
    },
    {
      name: "missing policy",
      mutate: (f: ReturnType<typeof fixture>) => {
        f.policies.delete("company");
      },
      error: "unknown-policy",
    },
    {
      name: "changed source behind the same tag",
      mutate: (f: ReturnType<typeof fixture>) => {
        const policy = f.policies.get("company");
        if (policy) {
          policy.sourceId = "family";
        }
      },
      error: "policy-identity-changed",
    },
  ])("rechecks $name before returning any payload", ({ mutate, error }) => {
    const f = fixture();
    f.add("company-note", "company");
    expect(f.request(["company-note"])).toHaveLength(1);
    mutate(f);
    expect(() => f.request(["company-note"])).toThrow(error);
  });

  it.each([
    { extras: { policyId: "unknown" }, error: "unknown-policy" },
    { extras: { provenance: [] }, error: "unexpected-field" },
    { extras: { derivedFrom: ["unknown"] }, error: "record-unavailable" },
    { extras: { profile: "personal" }, error: "personal-requires-host-capability" },
    { extras: { text: "x".repeat(4097) }, error: "invalid-content" },
    { extras: { activityId: "other-activity" }, error: "activity-denied" },
  ])(
    "rejects invalid or forged source metadata before persistence: $error",
    ({ extras, error }) => {
      const f = fixture();
      expect(() => f.add("invalid", "directive", extras)).toThrow(error);
      expect(f.store.entries()).toEqual([]);
    },
  );

  it("explicitly saves a separately released B directive without retaining or exporting its rationale", () => {
    const f = fixture();
    f.begin();
    f.add("rationale", "private", {
      profile: "ephemeral",
      temporaryId: "sidechat",
      text: "SYNTHETIC_PRIVATE_RATIONALE",
    });
    // Independent operator-enrolled release, not a derived summary of the rationale.
    f.add("direction-b", "directive", {
      profile: "ephemeral",
      temporaryId: "sidechat",
      text: "Use B for campaign X.",
    });

    expect(
      f.context.saveSelected({
        temporaryId: "sidechat",
        recipientId: "company",
        recordIds: ["direction-b"],
        profile: "shared",
      }),
    ).toEqual({ savedIds: ["saved:direction-b"], omittedCount: 0 });
    f.context.endTemporary("sidechat");
    expect(() => f.request(["rationale"])).toThrow("record-unavailable");
    expect(() => f.request(["direction-b"])).toThrow("record-unavailable");
    expect(
      f.create().requestContext({
        activityId: "campaign-x",
        recipientId: "company",
        recordIds: ["saved:direction-b"],
      }),
    ).toMatchObject([{ text: "Use B for campaign X." }]);
    expect(JSON.stringify(f.store.entries())).not.toContain("SYNTHETIC_PRIVATE_RATIONALE");
    f.add("continuation", "directive", {
      derivedFrom: ["saved:direction-b"],
      text: "Progress under the retained B directive",
    });
    expect(f.request(["continuation"], "company")).toHaveLength(1);
  });

  it("preserves source restrictions through exact saves and never partially saves an invalid selection", () => {
    const f = fixture();
    f.begin();
    f.add("allowed", "directive", { profile: "ephemeral", temporaryId: "sidechat" });
    f.add("restricted", "no-retain", { profile: "ephemeral", temporaryId: "sidechat" });
    expect(() =>
      f.context.saveSelected({
        temporaryId: "sidechat",
        recipientId: "home",
        recordIds: ["allowed", "restricted"],
        profile: "private",
      }),
    ).toThrow("retention-denied");
    expect(f.store.entries()).toEqual([]);

    f.add("company-secret", "company", { profile: "ephemeral", temporaryId: "sidechat" });
    f.context.saveSelected({
      temporaryId: "sidechat",
      recipientId: "home",
      recordIds: ["company-secret"],
      profile: "private",
    });
    f.context.endTemporary("sidechat");
    expect(f.request(["saved:company-secret"])).toHaveLength(1);
    expect(() => f.request(["saved:company-secret"], "family")).toThrow("audience-denied");
  });

  it("saves the eligible conversation only, with explicit omissions and no personal or future retention", () => {
    const f = fixture();
    f.begin();
    f.add("eligible", "directive", { profile: "ephemeral", temporaryId: "sidechat" });
    f.add("nonretainable", "no-retain", { profile: "ephemeral", temporaryId: "sidechat" });
    const read = vi.fn(() => "PERSONAL_ORIGINAL");
    f.context.attachPersonalView(
      {
        id: "personal-reference",
        activityId: "campaign-x",
        policyId: "private",
        temporaryId: "sidechat",
      },
      { assertCurrent: () => {}, read, close: () => {} },
    );
    f.add("personal-derived", "directive", {
      profile: "ephemeral",
      temporaryId: "sidechat",
      text: "PERSONAL_DERIVED",
      derivedFrom: ["personal-reference"],
    });

    expect(
      f.context.saveSelected({
        temporaryId: "sidechat",
        recipientId: "home",
        wholeConversation: true,
        profile: "private",
      }),
    ).toEqual({ savedIds: ["saved:eligible"], omittedCount: 3 });
    expect(read).not.toHaveBeenCalled();
    f.add("later", "directive", { profile: "ephemeral", temporaryId: "sidechat" });
    f.context.endTemporary("sidechat");
    expect(() => f.request(["later"])).toThrow("record-unavailable");
    const persisted = JSON.stringify(f.store.entries());
    expect(persisted).not.toContain("PERSONAL_ORIGINAL");
    expect(persisted).not.toContain("PERSONAL_DERIVED");
    expect(persisted).not.toContain("Synthetic later");
  });

  it.each(["expiry", "closure", "revocation"] as const)(
    "invalidates temporary references and inherited views on %s",
    (reason) => {
      const f = fixture();
      let permitted = true;
      f.context.beginTemporary(
        { id: "source-chat", activityId: "campaign-x", expiresAt: 2000 },
        () => {
          if (!permitted) {
            throw new Error("revoked");
          }
        },
      );
      f.begin("derived-chat", 3000);
      f.add("source", "private", { profile: "ephemeral", temporaryId: "source-chat" });
      f.add("derived", "directive", {
        profile: "ephemeral",
        temporaryId: "derived-chat",
        derivedFrom: ["source"],
      });
      expect(f.request(["derived"])).toHaveLength(1);
      if (reason === "expiry") {
        f.setTime(2000);
      }
      if (reason === "closure") {
        f.context.endTemporary("source-chat");
      }
      if (reason === "revocation") {
        permitted = false;
      }
      expect(() => f.request(["derived"])).toThrow("record-unavailable");
      expect(() => f.request(["source"])).toThrow("record-unavailable");
      expect(f.store.entries()).toEqual([]);
    },
  );

  it("requires a live host closure for personal access, checks audience before read, and closes its synthetic index on expiry", () => {
    const f = fixture();
    f.begin();
    const index = new Map([["selected", "SYNTHETIC_PERSONAL_ORIGINAL"]]);
    let active = true;
    const read = vi.fn(() => index.get("selected") ?? "unavailable");
    const close = vi.fn(() => {
      active = false;
      index.clear();
    });
    f.context.attachPersonalView(
      {
        id: "personal-view",
        activityId: "campaign-x",
        policyId: "private",
        temporaryId: "sidechat",
      },
      {
        assertCurrent: () => {
          if (!active) {
            throw new Error("closed");
          }
        },
        read,
        close,
      },
    );

    expect(() => f.request(["personal-view"], "family")).toThrow("audience-denied");
    expect(read).not.toHaveBeenCalled();
    expect(f.request(["personal-view"])).toMatchObject([
      { text: "SYNTHETIC_PERSONAL_ORIGINAL", profile: "personal" },
    ]);
    expect(() =>
      f.context.saveSelected({
        temporaryId: "sidechat",
        recipientId: "home",
        recordIds: ["personal-view"],
        profile: "private",
      }),
    ).toThrow("retention-denied");

    f.setTime(2000);
    expect(() => f.request(["personal-view"])).toThrow("record-unavailable");
    expect(close).toHaveBeenCalledOnce();
    expect(index.size).toBe(0);
    expect(f.store.entries()).toEqual([]);
  });

  it("retires personal references when the host capability is revoked during a read", () => {
    const f = fixture();
    f.begin();
    let active = true;
    const close = vi.fn();
    f.context.attachPersonalView(
      {
        id: "personal-view",
        activityId: "campaign-x",
        policyId: "private",
        temporaryId: "sidechat",
      },
      {
        assertCurrent: () => {
          if (!active) {
            throw new Error("revoked");
          }
        },
        read: () => {
          active = false;
          return "MUST_NOT_BE_RETURNED";
        },
        close,
      },
    );
    expect(() => f.request(["personal-view"])).toThrow("personal-view-unavailable");
    expect(() => f.request(["personal-view"])).toThrow("record-unavailable");
    expect(close).toHaveBeenCalledOnce();
  });
});
