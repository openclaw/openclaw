import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE } from "./default-workspace.js";
import {
  CURRENT_WORKSPACE_SCHEMA_VERSION,
  migrateWorkspaceDoc,
  validateWorkspaceDoc,
  type WorkspaceDoc,
} from "./schema.js";

function validDoc(): WorkspaceDoc {
  return structuredClone(DEFAULT_WORKSPACE);
}

function expectInvalid(mutator: (doc: WorkspaceDoc) => void, message: string) {
  const doc = validDoc();
  mutator(doc);

  expect(() => validateWorkspaceDoc(doc)).toThrow(message);
}

describe("Workspaces document schema", () => {
  it("accepts the default workspace seed", () => {
    expect(validateWorkspaceDoc(validDoc())).toEqual(validDoc());
  });

  it("requires stable workspace and tab resource ids in the canonical schema", () => {
    expect(validDoc()).toMatchObject({
      schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
      workspaceId: "default",
      tabs: [expect.objectContaining({ id: "main", slug: "main", revision: 1 })],
    });

    const missingWorkspaceId = structuredClone(validDoc()) as unknown as Record<string, unknown>;
    delete missingWorkspaceId.workspaceId;
    expect(() => validateWorkspaceDoc(missingWorkspaceId)).toThrow("workspaces.workspaceId");

    const missingTabId = structuredClone(validDoc()) as unknown as {
      tabs: Array<Record<string, unknown>>;
    };
    delete missingTabId.tabs[0]!.id;
    expect(() => validateWorkspaceDoc(missingTabId)).toThrow("tabs[0].id");

    const missingRevision = structuredClone(validDoc()) as unknown as {
      tabs: Array<Record<string, unknown>>;
    };
    delete missingRevision.tabs[0]!.revision;
    expect(() => validateWorkspaceDoc(missingRevision)).toThrow("tabs[0].revision");
  });

  it("migrates legacy v1 documents to deterministic stable resource ids", () => {
    const legacy = structuredClone(validDoc()) as unknown as {
      schemaVersion: number;
      workspaceId?: string;
      tabs: Array<{ id?: string; revision?: number; slug: string }>;
    };
    legacy.schemaVersion = 1;
    delete legacy.workspaceId;
    for (const tab of legacy.tabs) {
      delete tab.id;
      delete tab.revision;
    }

    const migrated = migrateWorkspaceDoc(legacy);

    expect(migrated.changed).toBe(true);
    expect(migrated.doc).toMatchObject({
      schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
      workspaceId: "default",
      tabs: [{ id: "main", slug: "main", revision: 1 }],
    });
    expect(migrateWorkspaceDoc(migrated.doc)).toEqual({ doc: migrated.doc, changed: false });
  });

  it("does not trust identity fields smuggled into the v1 document shape", () => {
    const legacy = structuredClone(validDoc()) as unknown as {
      schemaVersion: number;
      workspaceId: string;
      tabs: Array<{ id: string; slug: string; revision: number }>;
    };
    legacy.schemaVersion = 1;
    legacy.workspaceId = "forged";
    legacy.tabs[0]!.id = "forged-tab";
    legacy.tabs[0]!.revision = 999;

    expect(migrateWorkspaceDoc(legacy).doc).toMatchObject({
      workspaceId: "default",
      tabs: [{ id: "main", slug: "main", revision: 1 }],
    });
  });

  it("rejects duplicate tab resource ids independently of mutable slugs", () => {
    expectInvalid((doc) => {
      doc.tabs.push({
        ...structuredClone(doc.tabs[0]!),
        slug: "second",
        title: "Second",
      });
    }, "duplicate tab id");
  });

  it("rejects invalid tab slugs", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.slug = "Bad Slug";
    }, "tabs[0].slug");
  });

  it("rejects duplicate tab slugs", () => {
    expectInvalid((doc) => {
      doc.tabs.push({ ...structuredClone(doc.tabs[0]!), id: "duplicate", title: "Duplicate" });
    }, "duplicate tab slug");
  });

  it("rejects widget grid overflow", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.grid = { x: 10, y: 0, w: 3, h: 2 };
    }, "x + w");
  });

  it("rejects invalid widget kinds", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.kind = "builtin:unknown";
    }, "widgets[0].kind");
  });

  it("rejects a prototype-setter custom widget kind", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.kind = "custom:__proto__";
    }, "widgets[0].kind");
  });

  it("rejects invalid binding unions", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        bad: { source: "command", value: "date" } as never,
      };
    }, "bindings.bad.source");
  });

  it("rejects non-allowlisted rpc binding methods at write time", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        sessions: { source: "rpc", method: "config.get" },
      };
    }, "bindings.sessions.method is not allowlisted");
  });

  it("accepts bounded parameters for parameterized rpc methods", () => {
    const doc = validDoc();
    doc.tabs[0]!.widgets[0]!.bindings = {
      session: { source: "rpc", method: "sessions.get", params: { key: "agent:main:main" } },
    };

    expect(validateWorkspaceDoc(doc).tabs[0]?.widgets[0]?.bindings?.session).toEqual({
      source: "rpc",
      method: "sessions.get",
      params: { key: "agent:main:main" },
    });
  });

  it("rejects prototype-setter binding and widget names", () => {
    const doc = validDoc();
    doc.tabs[0]!.widgets[0]!.bindings = JSON.parse(
      '{"__proto__":{"source":"static","value":1}}',
    ) as WorkspaceDoc["tabs"][number]["widgets"][number]["bindings"];
    expect(() => validateWorkspaceDoc(doc)).toThrow("binding id is invalid");

    doc.tabs[0]!.widgets[0]!.bindings = {};
    doc.widgetsRegistry = JSON.parse(
      '{"__proto__":{"status":"pending","createdBy":"agent:main"}}',
    ) as WorkspaceDoc["widgetsRegistry"];
    expect(() => validateWorkspaceDoc(doc)).toThrow("name is invalid");
  });

  it("rejects non-object and oversized rpc parameters", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        session: { source: "rpc", method: "sessions.get", params: [] } as never,
      };
    }, "bindings.session.params must be an object");
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        session: { source: "rpc", method: "sessions.get", params: { key: "x".repeat(9_000) } },
      };
    }, "bindings.session.params must serialize to 8 KB or less");
  });

  it("rejects tabs and widgets over the caps", () => {
    expectInvalid((doc) => {
      doc.tabs = Array.from({ length: 33 }, (_, index) => ({
        ...structuredClone(doc.tabs[0]!),
        slug: `tab-${index}`,
      }));
    }, "tabs must contain at most 32 entries");

    expectInvalid((doc) => {
      doc.tabs[0]!.widgets = Array.from({ length: 25 }, (_, index) => ({
        ...structuredClone(doc.tabs[0]!.widgets[0]!),
        id: `w_${index}`,
      }));
    }, "widgets must contain at most 24 entries");
  });

  it("rejects invalid createdBy provenance", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.createdBy = "robot" as never;
    }, "createdBy");
  });
});
