import { describe, expect, it } from "vitest";
import { DATA_READ_RPC_ALLOWLIST } from "./binding-contract.js";
import { DEFAULT_DASHBOARD_WORKSPACE } from "./default-workspace.js";
import { validateWorkspaceDoc } from "./schema.js";

describe("default dashboard workspace", () => {
  it("passes write-time schema validation (seeds cleanly on fresh state)", () => {
    expect(() => validateWorkspaceDoc(DEFAULT_DASHBOARD_WORKSPACE)).not.toThrow();
  });

  it("ships a single curated system Overview tab", () => {
    expect(DEFAULT_DASHBOARD_WORKSPACE.tabs).toHaveLength(1);
    const [main] = DEFAULT_DASHBOARD_WORKSPACE.tabs;
    expect(main.slug).toBe("main");
    expect(main.createdBy).toBe("system");
    expect(DEFAULT_DASHBOARD_WORKSPACE.prefs.tabOrder).toEqual(["main"]);
  });

  it("matches the spec layout (usage cards + instances, sessions + cron, activity)", () => {
    const kinds = DEFAULT_DASHBOARD_WORKSPACE.tabs[0].widgets.map((w) => w.kind);
    expect(kinds).toEqual([
      "builtin:stat-card",
      "builtin:stat-card",
      "builtin:instances",
      "builtin:sessions",
      "builtin:cron",
      "builtin:activity",
    ]);
    // Activity spans the full width, taller (row 3).
    const activity = DEFAULT_DASHBOARD_WORKSPACE.tabs[0].widgets.find((w) => w.id === "activity");
    expect(activity?.grid).toMatchObject({ x: 0, w: 12 });
  });

  it("binds only allowlisted rpc methods", () => {
    for (const tab of DEFAULT_DASHBOARD_WORKSPACE.tabs) {
      for (const widget of tab.widgets) {
        for (const binding of Object.values(widget.bindings ?? {})) {
          if (binding.source === "rpc") {
            expect(DATA_READ_RPC_ALLOWLIST).toContain(binding.method);
          }
        }
      }
    }
  });
});
