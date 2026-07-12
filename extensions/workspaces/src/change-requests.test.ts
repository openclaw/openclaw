import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type {
  CreateWorkspaceChangeRequestInput,
  WorkspaceRequester,
  WorkspaceTabProposal,
} from "./change-requests.js";
import { WorkspaceStore } from "./store.js";

async function withStore<T>(run: (store: WorkspaceStore) => Promise<T> | T): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-requests-"));
  const store = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
  try {
    return await run(store);
  } finally {
    store.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function mainTabProposal(store: WorkspaceStore): WorkspaceTabProposal {
  const tab = store.read().tabs[0]!;
  return {
    slug: tab.slug,
    title: tab.title,
    hidden: tab.hidden,
    widgets: tab.widgets.map(({ createdBy: _createdBy, ...widget }) => widget),
  };
}

function createHumanRequest(
  store: WorkspaceStore,
  overrides: Partial<CreateWorkspaceChangeRequestInput> = {},
) {
  const proposal = mainTabProposal(store);
  proposal.title = "Requested title";
  const input: CreateWorkspaceChangeRequestInput = {
    id: "request-1",
    tabId: "main",
    requester: { principalId: "human-1", kind: "human" },
    baseTabRevision: 1,
    idempotencyKey: "edit-main-title",
    proposal,
    ...overrides,
  };
  return store.createChangeRequest(input);
}

describe("WorkspaceStore change requests", () => {
  it("creates a validated, hashed, requester-idempotent pending request", async () => {
    await withStore((store) => {
      const created = createHumanRequest(store);

      expect(created).toMatchObject({
        id: "request-1",
        isolationDomainId: "domain-1",
        workspaceId: "default",
        tabId: "main",
        requester: { principalId: "human-1", kind: "human" },
        baseTabRevision: 1,
        idempotencyKey: "edit-main-title",
        state: "pending",
        proposal: { title: "Requested title" },
      });
      expect(created.proposalSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(created.proposal).not.toHaveProperty("id");
      expect(created.proposal).not.toHaveProperty("revision");
      expect(created.proposal).not.toHaveProperty("createdBy");
      expect(store.readChangeRequest("request-1")).toEqual(created);
      expect(store.listChangeRequests({ tabId: "main", state: "pending" })).toEqual([created]);

      expect(
        store.createChangeRequest({
          id: "ignored-on-idempotent-retry",
          tabId: "main",
          requester: { principalId: "human-1", kind: "human" },
          baseTabRevision: 1,
          idempotencyKey: "edit-main-title",
          proposal: created.proposal,
        }),
      ).toEqual(created);
    });
  });

  it("rejects idempotency-key reuse for a different immutable payload", async () => {
    await withStore((store) => {
      createHumanRequest(store);
      const proposal = mainTabProposal(store);
      proposal.title = "Different title";

      expect(() =>
        store.createChangeRequest({
          id: "request-2",
          tabId: "main",
          requester: { principalId: "human-1", kind: "human" },
          baseTabRevision: 1,
          idempotencyKey: "edit-main-title",
          proposal,
        }),
      ).toThrow("idempotency key already belongs to a different change request payload");
    });
  });

  it("scopes an idempotency key to the requester rather than one tab", async () => {
    await withStore((store) => {
      store.mutate(
        (draft) => {
          draft.tabs.push({
            id: "second",
            revision: 1,
            slug: "second",
            title: "Second",
            hidden: false,
            createdBy: "user",
            widgets: [],
          });
          draft.prefs.tabOrder.push("second");
        },
        { actor: "user" },
      );
      createHumanRequest(store, { baseTabRevision: 1 });

      expect(() =>
        store.createChangeRequest({
          id: "request-2",
          tabId: "second",
          requester: { principalId: "human-1", kind: "human" },
          baseTabRevision: 1,
          idempotencyKey: "edit-main-title",
          proposal: {
            slug: "second",
            title: "Changed second",
            hidden: false,
            widgets: [],
          },
        }),
      ).toThrow("idempotency key already belongs to a different change request payload");
    });
  });

  it("enforces immutable requester provenance shapes", async () => {
    await withStore((store) => {
      const proposal = mainTabProposal(store);

      expect(() =>
        store.createChangeRequest({
          id: "human-with-delegation",
          tabId: "main",
          requester: {
            principalId: "human-1",
            kind: "human",
            delegationId: "delegation-1",
            sponsorPrincipalId: "human-1",
          } as unknown as WorkspaceRequester,
          baseTabRevision: 1,
          idempotencyKey: "human-with-delegation",
          proposal,
        }),
      ).toThrow("human requester cannot carry delegation provenance");

      expect(() =>
        store.createChangeRequest({
          id: "partial-agent-provenance",
          tabId: "main",
          requester: {
            principalId: "agent-1",
            kind: "agent",
            delegationId: "delegation-1",
          },
          baseTabRevision: 1,
          idempotencyKey: "partial-agent-provenance",
          proposal,
        }),
      ).toThrow("agent delegation and sponsor provenance must be provided together");

      const created = store.createChangeRequest({
        id: "agent-request",
        tabId: "main",
        requester: {
          principalId: "agent-1",
          kind: "agent",
          delegationId: "delegation-1",
          sponsorPrincipalId: "human-1",
        },
        baseTabRevision: 1,
        idempotencyKey: "agent-request",
        proposal,
      });
      expect(created.requester).toEqual({
        principalId: "agent-1",
        kind: "agent",
        delegationId: "delegation-1",
        sponsorPrincipalId: "human-1",
      });
    });
  });

  it("rejects forged immutable/provenance fields and oversized proposals", async () => {
    await withStore((store) => {
      const proposal = mainTabProposal(store) as unknown as Record<string, unknown>;
      proposal.id = "forged";
      expect(() => createHumanRequest(store, { proposal })).toThrow(
        "proposal contains forbidden field: id",
      );

      const oversized = mainTabProposal(store);
      oversized.widgets[0]!.props = { text: "x".repeat(140_000) };
      expect(() => createHumanRequest(store, { id: "large", proposal: oversized })).toThrow(
        "change request proposal exceeds 128 KB",
      );
    });
  });

  it("cancels only for the immutable requester and never reopens a terminal request", async () => {
    await withStore((store) => {
      createHumanRequest(store);

      expect(() =>
        store.cancelChangeRequest({
          id: "request-1",
          requester: { principalId: "human-2", kind: "human" },
        }),
      ).toThrow("only the request creator can cancel a change request");

      const cancelled = store.cancelChangeRequest({
        id: "request-1",
        requester: { principalId: "human-1", kind: "human" },
      });
      expect(cancelled).toMatchObject({ state: "cancelled" });
      expect(cancelled.cancelledAt).toEqual(expect.any(String));
      expect(() =>
        store.cancelChangeRequest({
          id: "request-1",
          requester: { principalId: "human-1", kind: "human" },
        }),
      ).toThrow("change request is already terminal: cancelled");
    });
  });

  it("atomically approves against the current revision while reconciling identity and provenance", async () => {
    await withStore((store) => {
      const proposal = mainTabProposal(store);
      proposal.title = "Agent proposal";
      proposal.widgets.push({
        id: "agent-widget",
        kind: "builtin:markdown",
        grid: { x: 0, y: 4, w: 4, h: 2 },
        collapsed: false,
        hidden: false,
        props: { text: "hello" },
      });
      store.createChangeRequest({
        id: "request-1",
        tabId: "main",
        requester: {
          principalId: "agent-1",
          kind: "agent",
          delegationId: "delegation-1",
          sponsorPrincipalId: "owner-1",
        },
        baseTabRevision: 1,
        idempotencyKey: "agent-edit",
        proposal,
      });

      const result = store.decideChangeRequest({
        id: "request-1",
        decision: "approved",
        decider: { principalId: "owner-1", kind: "human" },
      });

      expect(result.applied).toBe(true);
      expect(result.request).toMatchObject({
        state: "approved",
        decider: { principalId: "owner-1", kind: "human" },
      });
      expect(result.doc.tabs[0]).toMatchObject({
        id: "main",
        revision: 2,
        title: "Agent proposal",
        createdBy: "system",
      });
      expect(
        result.doc.tabs[0]?.widgets.find((widget) => widget.id === "agent-widget"),
      ).toMatchObject({ createdBy: "agent:agent-1" });
      expect(result.doc.workspaceVersion).toBe(2);
      expect(store.read()).toEqual(result.doc);
      expect(() => store.undo()).toThrow("no workspace undo snapshot available");
    });
  });

  it("marks approval conflict without changing the document when the tab revision drifted", async () => {
    await withStore((store) => {
      createHumanRequest(store);
      store.mutate(
        (draft) => {
          draft.tabs[0]!.title = "Changed first";
        },
        { actor: "user" },
      );
      const beforeDecision = store.read();

      const result = store.decideChangeRequest({
        id: "request-1",
        decision: "approved",
        decider: { principalId: "owner-1", kind: "human" },
      });

      expect(result).toMatchObject({ applied: false, request: { state: "conflict" } });
      expect(result.doc).toEqual(beforeDecision);
      expect(store.read()).toEqual(beforeDecision);
    });
  });

  it("rechecks the locked database row instead of an earlier process-local cache", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-request-race-"));
    const requesterStore = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
    const concurrentStore = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
    try {
      createHumanRequest(requesterStore);
      concurrentStore.mutate(
        (draft) => {
          draft.tabs[0]!.title = "Concurrent update";
        },
        { actor: "user" },
      );

      const result = requesterStore.decideChangeRequest({
        id: "request-1",
        decision: "approved",
        decider: { principalId: "owner-1", kind: "human" },
      });

      expect(result).toMatchObject({ applied: false, request: { state: "conflict" } });
      expect(result.doc.tabs[0]).toMatchObject({ title: "Concurrent update", revision: 2 });
    } finally {
      requesterStore.close();
      concurrentStore.close();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records a human rejection without changing the document", async () => {
    await withStore((store) => {
      createHumanRequest(store);
      const before = store.read();

      const result = store.decideChangeRequest({
        id: "request-1",
        decision: "rejected",
        reason: "Needs a narrower scope",
        decider: { principalId: "owner-1", kind: "human" },
      });

      expect(result).toMatchObject({
        applied: false,
        request: {
          state: "rejected",
          decider: { principalId: "owner-1", kind: "human" },
          decisionReason: "Needs a narrower scope",
        },
        doc: before,
      });
    });
  });

  it("guards immutable payloads, monotonic state, deletion, and decision audit in SQL", async () => {
    await withStore((store) => {
      createHumanRequest(store);
      store.cancelChangeRequest({
        id: "request-1",
        requester: { principalId: "human-1", kind: "human" },
      });
      const db = new DatabaseSync(store.dbPath);
      try {
        expect(() =>
          db
            .prepare("UPDATE workspace_change_requests SET proposal_json = ? WHERE id = ?")
            .run("{}", "request-1"),
        ).toThrow(/immutable payload/);
        expect(() =>
          db
            .prepare("UPDATE workspace_change_requests SET state = ? WHERE id = ?")
            .run("approved", "request-1"),
        ).toThrow(/terminal/);
        expect(() =>
          db.prepare("DELETE FROM workspace_change_requests WHERE id = ?").run("request-1"),
        ).toThrow(/cannot be deleted/);
        expect(() =>
          db.prepare("UPDATE workspace_change_request_events SET reason = ?").run("forged"),
        ).toThrow(/audit events are append-only/);
        expect(() => db.prepare("DELETE FROM workspace_change_request_events").run()).toThrow(
          /audit events are append-only/,
        );
        expect(() =>
          db
            .prepare(
              `INSERT INTO workspace_change_request_events (
                isolation_domain_id, workspace_id, request_id, from_state, to_state,
                actor_principal_id, actor_kind, reason, created_ms
               ) VALUES ('domain-1', 'default', 'request-1', 'pending', 'approved',
                 'forged', 'human', NULL, 1)`,
            )
            .run(),
        ).toThrow(/audit event is invalid|UNIQUE/);

        const events = db
          .prepare(
            `SELECT from_state, to_state, actor_principal_id, actor_kind
             FROM workspace_change_request_events ORDER BY event_id`,
          )
          .all();
        expect(events).toEqual([
          {
            from_state: null,
            to_state: "pending",
            actor_principal_id: "human-1",
            actor_kind: "human",
          },
          {
            from_state: "pending",
            to_state: "cancelled",
            actor_principal_id: "human-1",
            actor_kind: "human",
          },
        ]);
      } finally {
        db.close();
      }
    });
  });

  it("prevents direct mutation of terminal decision metadata", async () => {
    await withStore((store) => {
      createHumanRequest(store);
      store.decideChangeRequest({
        id: "request-1",
        decision: "approved",
        decider: { principalId: "owner-1", kind: "human" },
      });
      const db = new DatabaseSync(store.dbPath);
      try {
        expect(() =>
          db
            .prepare("UPDATE workspace_change_requests SET decision_reason = ? WHERE id = ?")
            .run("rewritten", "request-1"),
        ).toThrow(/terminal decision metadata cannot be changed/);
      } finally {
        db.close();
      }
    });
  });
});
