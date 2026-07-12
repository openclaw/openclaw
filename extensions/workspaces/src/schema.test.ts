import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE } from "./default-workspace.js";
import { migrateWorkspaceDoc, validateWorkspaceDoc, type WorkspaceDoc } from "./schema.js";

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

  it("rejects invalid tab slugs", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.slug = "Bad Slug";
    }, "tabs[0].slug");
  });

  it("rejects duplicate tab slugs", () => {
    expectInvalid((doc) => {
      doc.tabs.push({ ...structuredClone(doc.tabs[0]!), title: "Duplicate" });
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

  it("accepts stream bindings on readable event channels", () => {
    const doc = validDoc();
    doc.tabs[0]!.widgets[0]!.bindings = {
      live: { source: "stream", event: "presence", pointer: "/online" },
    } as never;

    expect(() => validateWorkspaceDoc(doc)).not.toThrow();
  });

  it("rejects stream bindings on non-allowlisted event channels", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        live: { source: "stream", event: "evil.channel" },
      } as never;
    }, "bindings.live.event is not allowlisted");
  });

  it("does not advertise the write-scoped workspace change event as stream-readable", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        live: { source: "stream", event: "plugin.workspaces.changed" },
      } as never;
    }, "bindings.live.event is not allowlisted");
  });

  it("requires an explicit output binding when a widget has multiple bindings", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        a: { source: "static", value: 1 },
        b: { source: "static", value: 2 },
      } as never;
    }, "outputBinding is required when bindings contains more than one entry");
  });

  it("accepts a validated non-first output binding", () => {
    const doc = validDoc();
    doc.tabs[0]!.widgets[0]!.bindings = {
      a: { source: "static", value: 2 },
      b: { source: "static", value: 3 },
      total: { source: "computed", op: "sum", inputs: ["a", "b"] },
    } as never;
    doc.tabs[0]!.widgets[0]!.outputBinding = "total";

    expect(validateWorkspaceDoc(doc).tabs[0]!.widgets[0]).toMatchObject({
      outputBinding: "total",
    });
  });

  it("migrates the legacy first-binding choice into an explicit outputBinding", () => {
    const doc = validDoc();
    doc.tabs[0]!.widgets[0]!.bindings = {
      first: { source: "static", value: 1 },
      second: { source: "static", value: 2 },
    };

    const migrated = migrateWorkspaceDoc(doc);
    expect(migrated.changed).toBe(true);
    expect(migrated.doc.tabs[0]!.widgets[0]!.outputBinding).toBe("first");
  });

  it("rejects prototype-chain names as computed inputs and output bindings", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        total: { source: "computed", op: "sum", inputs: ["constructor"] },
      } as never;
    }, "references unknown binding: constructor");

    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = { value: { source: "static", value: 1 } };
      doc.tabs[0]!.widgets[0]!.outputBinding = "constructor";
    }, "references unknown binding: constructor");
  });

  it("rejects an output binding that is absent from the widget binding map", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        value: { source: "static", value: 1 },
      } as never;
      doc.tabs[0]!.widgets[0]!.outputBinding = "missing";
    }, "outputBinding references unknown binding: missing");
  });

  it("accepts every computed operation with valid sibling inputs", () => {
    for (const op of ["sum", "avg", "min", "max", "last", "count"]) {
      const doc = validDoc();
      doc.tabs[0]!.widgets[0]!.bindings = {
        total: { source: "computed", op, inputs: ["a", "b"] },
        a: { source: "static", value: 1 },
        b: { source: "static", value: 2 },
      } as never;
      doc.tabs[0]!.widgets[0]!.outputBinding = "total";
      expect(() => validateWorkspaceDoc(doc)).not.toThrow();
    }

    for (const [op, arg] of [
      ["pick", "/nested/value"],
      ["format", "{0} of {1}"],
    ]) {
      const doc = validDoc();
      doc.tabs[0]!.widgets[0]!.bindings = {
        derived: { source: "computed", op, inputs: ["a"], arg },
        a: { source: "static", value: 1 },
      } as never;
      doc.tabs[0]!.widgets[0]!.outputBinding = "derived";
      expect(() => validateWorkspaceDoc(doc)).not.toThrow();
    }
  });

  it("rejects invalid computed operations, inputs, and arguments", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        total: { source: "computed", op: "eval", inputs: ["a"] },
        a: { source: "static", value: 1 },
      } as never;
    }, "bindings.total.op is not a valid computed op");

    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        total: { source: "computed", op: "sum", inputs: [] },
      } as never;
    }, "bindings.total.inputs must contain 1 to 32 entries");

    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        derived: { source: "computed", op: "pick", inputs: ["a"] },
        a: { source: "static", value: 1 },
      } as never;
    }, "bindings.derived.arg is required for the pick op");

    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        total: { source: "computed", op: "sum", inputs: ["a"], arg: "unused" },
        a: { source: "static", value: 1 },
      } as never;
    }, "bindings.total.arg is not allowed for the sum op");
  });

  it("rejects computed inputs that reference missing or computed siblings", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        total: { source: "computed", op: "sum", inputs: ["missing"] },
      } as never;
    }, "references unknown binding: missing");

    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        total: { source: "computed", op: "sum", inputs: ["mid"] },
        mid: { source: "computed", op: "sum", inputs: ["a"] },
        a: { source: "static", value: 1 },
      } as never;
    }, "may not reference another computed binding: mid");

    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        total: { source: "computed", op: "sum", inputs: ["live"] },
        live: { source: "stream", event: "presence" },
      } as never;
    }, "may not reference a stream binding: live");
  });
});
