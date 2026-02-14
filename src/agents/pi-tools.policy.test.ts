import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSubagentToolPolicy } from "./pi-tools.policy.js";

describe("resolveSubagentToolPolicy", () => {
  it("includes session tools in deny list when recursive spawn is disabled", () => {
    const policy = resolveSubagentToolPolicy({
      agents: {
        defaults: {
          subagents: {
            allowRecursiveSpawn: false,
          },
        },
      },
    } as OpenClawConfig);

    expect(policy.deny).toEqual(
      expect.arrayContaining(["sessions_list", "sessions_history", "sessions_send", "sessions_spawn"]),
    );
  });

  it("excludes session tools from deny list when recursive spawn is enabled", () => {
    const policy = resolveSubagentToolPolicy({
      agents: {
        defaults: {
          subagents: {
            allowRecursiveSpawn: true,
          },
        },
      },
    } as OpenClawConfig);

    expect(policy.deny).not.toContain("sessions_list");
    expect(policy.deny).not.toContain("sessions_history");
    expect(policy.deny).not.toContain("sessions_send");
    expect(policy.deny).not.toContain("sessions_spawn");
    expect(policy.deny).toContain("gateway");
  });
});
