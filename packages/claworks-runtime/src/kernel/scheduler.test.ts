import { describe, expect, it } from "vitest";
import type { PlaybookDefinition } from "../planes/orch/playbook-types.js";
import { createPlaybookScheduler } from "./scheduler.js";

describe("createPlaybookScheduler", () => {
  it("registers schedule triggers and reload replaces jobs", () => {
    const fired: string[] = [];
    const scheduler = createPlaybookScheduler({
      onFire: (id) => {
        fired.push(id);
      },
    });

    const playbooks: PlaybookDefinition[] = [
      {
        id: "hourly_check",
        name: "Hourly",
        pack: "base",
        priority: 0,
        trigger: { kind: "schedule", cron: "0 * * * *" },
        steps: [],
      },
      {
        id: "manual_only",
        name: "Manual",
        pack: "base",
        priority: 0,
        trigger: { kind: "manual" },
        steps: [],
      },
    ];

    expect(() => scheduler.reload(playbooks)).not.toThrow();
    scheduler.reload([]);
    scheduler.stop();
    expect(fired).toEqual([]);
  });
});
