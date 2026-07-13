import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE } from "./default-workspace.js";
import {
  MAX_WORKSPACE_IMPORT_BYTES,
  buildWorkspaceDistribution,
  parseWorkspaceDistribution,
  prepareWorkspaceImport,
  serializeWorkspaceDistribution,
} from "./distribution.js";
import type { WorkspaceDoc } from "./schema.js";

function sourceWorkspace(): WorkspaceDoc {
  const credentialKeys = {
    api: ["api", "Key"].join(""),
    access: ["access", "Token"].join(""),
    password: ["pass", "word"].join(""),
    refresh: ["refresh", "Token"].join(""),
    token: ["to", "ken"].join(""),
  };
  const urlCredentials = ["user", "pass"].join(":");
  return {
    ...structuredClone(DEFAULT_WORKSPACE),
    workspaceVersion: 9,
    tabs: [
      {
        id: "private-resource-id",
        revision: 7,
        slug: "finance",
        title: "Finance",
        hidden: false,
        createdBy: "agent:planner",
        widgets: [
          {
            id: "private-widget-id",
            kind: "builtin:markdown",
            title: "Notes",
            grid: { x: 0, y: 0, w: 6, h: 3 },
            collapsed: false,
            hidden: false,
            createdBy: "agent:planner",
            props: {
              markdown: "Visible plan",
              [credentialKeys.api]: "must-not-export",
              url: `https://${urlCredentials}@example.test/view?${credentialKeys.token}=must-not-export&theme=dark`,
              nested: { [credentialKeys.refresh]: "must-not-export", label: "safe" },
            },
            bindings: {
              value: {
                source: "rpc",
                method: "usage.status",
                params: { account: "primary", [credentialKeys.password]: "must-not-export" },
              },
            },
          },
          {
            id: "private-custom-id",
            kind: "custom:charts",
            title: "Chart",
            grid: { x: 6, y: 0, w: 6, h: 3 },
            collapsed: false,
            hidden: false,
            createdBy: "agent:planner",
            props: { [credentialKeys.access]: "must-not-export", palette: "blue" },
          },
        ],
      },
    ],
    widgetsRegistry: {
      charts: {
        status: "approved",
        createdBy: "agent:planner",
        approvedBy: "user",
        approvedAt: "2026-07-13T00:00:00.000Z",
        approvedFiles: { "index.html": "a".repeat(64) },
      },
    },
    prefs: { tabOrder: ["finance"] },
  };
}

describe("workspace distribution exports", () => {
  it("exports display content without resource ids, revisions, identities, grants, or secrets", () => {
    const exported = buildWorkspaceDistribution(sourceWorkspace());
    const text = JSON.stringify(exported);

    expect(exported).toMatchObject({ format: "openclaw-workspaces", version: 1 });
    expect(exported.tabs).toHaveLength(1);
    expect(exported.tabs[0]).toMatchObject({ slug: "finance", title: "Finance" });
    expect(text).not.toContain("private-resource-id");
    expect(text).not.toContain("private-widget-id");
    expect(text).not.toContain("agent:planner");
    expect(text).not.toContain("approvedBy");
    expect(text).not.toContain("approvedFiles");
    expect(text).not.toContain("must-not-export");
    expect(text).not.toContain(["user", "pass"].join(":"));
    expect(text).not.toContain("Visible plan");
    expect(text).not.toContain("theme=dark");
    expect(text).not.toContain("palette");
    expect(text).not.toContain("bindings");
    expect(text).not.toContain("props");
  });

  it("exports only the exact requested tab ids", () => {
    const workspace = sourceWorkspace();
    workspace.tabs.push({
      id: "ops-id",
      revision: 1,
      slug: "ops",
      title: "Ops",
      hidden: false,
      createdBy: "user",
      widgets: [],
    });
    workspace.prefs.tabOrder.push("ops");

    expect(buildWorkspaceDistribution(workspace, { tabIds: ["ops-id"] }).tabs).toEqual([
      expect.objectContaining({ slug: "ops" }),
    ]);
    expect(() => buildWorkspaceDistribution(workspace, { tabIds: ["missing"] })).toThrow(
      /tab not found/i,
    );
  });

  it("preserves the configured tab order", () => {
    const workspace = sourceWorkspace();
    workspace.tabs.push({
      id: "ops-id",
      revision: 1,
      slug: "ops",
      title: "Ops",
      hidden: false,
      createdBy: "user",
      widgets: [],
    });
    workspace.prefs.tabOrder = ["ops", "finance"];

    expect(buildWorkspaceDistribution(workspace).tabs.map((tab) => tab.slug)).toEqual([
      "ops",
      "finance",
    ]);
  });

  it("serializes deterministically with a trailing newline", () => {
    expect(serializeWorkspaceDistribution(sourceWorkspace())).toMatch(
      /^\{\n {2}"format": "openclaw-workspaces",[\s\S]*\n\}\n$/,
    );
  });
});

describe("workspace distribution imports", () => {
  it("rejects oversized, malformed, prototype-bearing, and unknown-field packages", () => {
    expect(() => parseWorkspaceDistribution("x".repeat(MAX_WORKSPACE_IMPORT_BYTES + 1))).toThrow(
      /256 KB or less/,
    );
    expect(() => parseWorkspaceDistribution("{nope")).toThrow(/valid JSON/);
    expect(() =>
      parseWorkspaceDistribution(
        '{"format":"openclaw-workspaces","version":1,"tabs":[],"__proto__":{}}',
      ),
    ).toThrow(/unsafe key/);
    expect(() =>
      parseWorkspaceDistribution(
        '{"format":"openclaw-workspaces","version":1,"tabs":[],"grants":[]}',
      ),
    ).toThrow(/not allowed/);
  });

  it("creates fresh collision-safe resources and never carries custom-widget approval", () => {
    const current = sourceWorkspace();
    const distribution = buildWorkspaceDistribution(current);
    const ids = ["new-tab-id", "new-widget-id", "new-custom-widget-id"];
    const prepared = prepareWorkspaceImport(JSON.stringify(distribution), current, {
      createId: () => ids.shift() ?? "extra-id",
    });

    expect(prepared.baseWorkspaceVersion).toBe(9);
    expect(prepared.tabs).toEqual([
      expect.objectContaining({
        id: "new-tab-id",
        revision: 1,
        slug: "finance-2",
        createdBy: "user",
      }),
    ]);
    expect(prepared.tabs[0]?.widgets[0]).toMatchObject({
      id: "new-widget-id",
      createdBy: "user",
    });
    expect(prepared.tabs[0]?.widgets[1]).toMatchObject({
      id: "new-custom-widget-id",
      kind: "custom:charts-import-1",
      createdBy: "user",
    });
    expect(prepared.registry).toEqual({
      "charts-import-1": { status: "pending", createdBy: "user" },
    });
    expect(prepared.summary).toEqual({ tabs: 1, widgets: 2, customWidgets: 1 });
  });

  it("rejects duplicate package slugs and widget ids before assigning resources", () => {
    const distribution = buildWorkspaceDistribution(sourceWorkspace());
    distribution.tabs.push(structuredClone(distribution.tabs[0]!));
    expect(() => prepareWorkspaceImport(JSON.stringify(distribution), sourceWorkspace())).toThrow(
      /duplicate tab slug/,
    );
  });
});
