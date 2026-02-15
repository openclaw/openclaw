import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAllowRecursiveSpawn,
  resolveMaxChildrenPerAgent,
  resolveMaxSpawnDepth,
  resolveSubagentRunTimeoutSeconds,
} from "./recursive-spawn-config.js";

describe("resolveAllowRecursiveSpawn", () => {
  it("returns false by default", () => {
    expect(resolveAllowRecursiveSpawn({}, "main")).toBe(false);
  });

  it("returns global default when set", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { subagents: { allowRecursiveSpawn: true } } },
    };
    expect(resolveAllowRecursiveSpawn(cfg, "main")).toBe(true);
  });

  it("per-agent overrides global", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { subagents: { allowRecursiveSpawn: false } },
        list: [{ id: "main", subagents: { allowRecursiveSpawn: true } }],
      },
    };
    expect(resolveAllowRecursiveSpawn(cfg, "main")).toBe(true);
  });

  it("returns false when agent not found", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "other", subagents: { allowRecursiveSpawn: true } }] },
    };
    expect(resolveAllowRecursiveSpawn(cfg, "main")).toBe(false);
  });
});

describe("resolveMaxChildrenPerAgent", () => {
  it("returns 4 by default", () => {
    expect(resolveMaxChildrenPerAgent({}, "main")).toBe(4);
  });

  it("returns global default when set", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { subagents: { maxChildrenPerAgent: 6 } } },
    };
    expect(resolveMaxChildrenPerAgent(cfg, "main")).toBe(6);
  });

  it("per-agent overrides global", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { subagents: { maxChildrenPerAgent: 6 } },
        list: [{ id: "main", subagents: { maxChildrenPerAgent: 2 } }],
      },
    };
    expect(resolveMaxChildrenPerAgent(cfg, "main")).toBe(2);
  });

  it("clamps to 1-20 range", () => {
    const cfg1: OpenClawConfig = {
      agents: { defaults: { subagents: { maxChildrenPerAgent: 0 } } },
    };
    expect(resolveMaxChildrenPerAgent(cfg1, "main")).toBe(1);

    const cfg2: OpenClawConfig = {
      agents: { defaults: { subagents: { maxChildrenPerAgent: 50 } } },
    };
    expect(resolveMaxChildrenPerAgent(cfg2, "main")).toBe(20);
  });
});

describe("resolveMaxSpawnDepth", () => {
  it("returns 3 by default", () => {
    expect(resolveMaxSpawnDepth({}, "main")).toBe(3);
  });

  it("returns global default when set", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { subagents: { maxDepth: 5 } } },
    };
    expect(resolveMaxSpawnDepth(cfg, "main")).toBe(5);
  });

  it("per-agent overrides global", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { subagents: { maxDepth: 5 } },
        list: [{ id: "main", subagents: { maxDepth: 2 } }],
      },
    };
    expect(resolveMaxSpawnDepth(cfg, "main")).toBe(2);
  });

  it("clamps to 1-10 range", () => {
    const cfg1: OpenClawConfig = {
      agents: { defaults: { subagents: { maxDepth: 0 } } },
    };
    expect(resolveMaxSpawnDepth(cfg1, "main")).toBe(1);

    const cfg2: OpenClawConfig = {
      agents: { defaults: { subagents: { maxDepth: 99 } } },
    };
    expect(resolveMaxSpawnDepth(cfg2, "main")).toBe(10);
  });
});

describe("resolveSubagentRunTimeoutSeconds", () => {
  it("returns 0 by default", () => {
    expect(resolveSubagentRunTimeoutSeconds({}, "main")).toBe(0);
  });

  it("returns global default when set", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { subagents: { runTimeoutSeconds: 9 } } },
    };
    expect(resolveSubagentRunTimeoutSeconds(cfg, "main")).toBe(9);
  });

  it("per-agent overrides global", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { subagents: { runTimeoutSeconds: 9 } },
        list: [{ id: "main", subagents: { runTimeoutSeconds: 3 } }],
      },
    };
    expect(resolveSubagentRunTimeoutSeconds(cfg, "main")).toBe(3);
  });

  it("supports explicit 0 in per-agent config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { subagents: { runTimeoutSeconds: 9 } },
        list: [{ id: "main", subagents: { runTimeoutSeconds: 0 } }],
      },
    };
    expect(resolveSubagentRunTimeoutSeconds(cfg, "main")).toBe(0);
  });

  it("floors decimal values to integers", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { subagents: { runTimeoutSeconds: 5.9 } },
        list: [{ id: "main", subagents: { runTimeoutSeconds: 4.8 } }],
      },
    };
    expect(resolveSubagentRunTimeoutSeconds(cfg, "main")).toBe(4);
  });
});
