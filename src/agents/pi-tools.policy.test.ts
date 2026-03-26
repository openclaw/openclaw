import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  filterToolsByPolicy,
  isToolAllowedByPolicyName,
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicy,
  resolveSubagentToolPolicyForSession,
} from "./pi-tools.policy.js";
import { createStubTool } from "./test-helpers/pi-tool-stubs.js";

describe("pi-tools.policy", () => {
  it("treats * in allow as allow-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { allow: ["*"] });
    expect(filtered.map((tool) => tool.name)).toEqual(["read", "exec"]);
  });

  it("treats * in deny as deny-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { deny: ["*"] });
    expect(filtered).toEqual([]);
  });

  it("supports wildcard allow/deny patterns", () => {
    expect(isToolAllowedByPolicyName("web_fetch", { allow: ["web_*"] })).toBe(true);
    expect(isToolAllowedByPolicyName("web_search", { deny: ["web_*"] })).toBe(false);
  });

  it("keeps apply_patch when exec is allowlisted", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { allow: ["exec"] })).toBe(true);
  });
});

describe("resolveSubagentToolPolicy depth awareness", () => {
  const baseCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
  } as unknown as OpenClawConfig;

  const deepCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 3 } } },
  } as unknown as OpenClawConfig;

  const leafCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 1 } } },
  } as unknown as OpenClawConfig;

  it("applies subagent tools.alsoAllow to re-enable default-denied tools", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { alsoAllow: ["sessions_send"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("sessions_send", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("cron", policy)).toBe(false);
  });

  it("applies subagent tools.allow to re-enable default-denied tools", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { allow: ["sessions_send"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("sessions_send", policy)).toBe(true);
  });

  it("merges subagent tools.alsoAllow into tools.allow when both are set", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: {
        subagents: { tools: { allow: ["sessions_spawn"], alsoAllow: ["sessions_send"] } },
      },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(policy.allow).toEqual(["sessions_spawn", "sessions_send"]);
  });

  it("keeps configured deny precedence over allow and alsoAllow", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: {
        subagents: {
          tools: {
            allow: ["sessions_send"],
            alsoAllow: ["sessions_send"],
            deny: ["sessions_send"],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("sessions_send", policy)).toBe(false);
  });

  it("does not create a restrictive allowlist when only alsoAllow is configured", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { alsoAllow: ["sessions_send"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(policy.allow).toBeUndefined();
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows subagents", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows sessions_list", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows sessions_history", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_history", policy)).toBe(true);
  });

  it("depth-1 orchestrator still denies gateway, cron, memory", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("gateway", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("cron", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("memory_search", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("memory_get", policy)).toBe(false);
  });

  it("depth-2 leaf denies sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 2);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });

  it("depth-2 orchestrator (maxSpawnDepth=3) allows sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(deepCfg, 2);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("depth-3 leaf (maxSpawnDepth=3) denies sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(deepCfg, 3);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });

  it("depth-2 leaf denies subagents", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 2);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(false);
  });

  it("depth-2 leaf denies sessions_list and sessions_history", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 2);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("sessions_history", policy)).toBe(false);
  });

  it("depth-1 leaf (maxSpawnDepth=1) denies sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(leafCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });

  it("depth-1 leaf (maxSpawnDepth=1) denies sessions_list", () => {
    const policy = resolveSubagentToolPolicy(leafCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(false);
  });

  it("uses stored leaf role for flat depth-1 session keys", () => {
    const storePath = path.join(
      os.tmpdir(),
      `openclaw-subagent-policy-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:subagent:flat-leaf": {
            sessionId: "flat-leaf",
            updatedAt: Date.now(),
            spawnDepth: 1,
            subagentRole: "leaf",
            subagentControlScope: "none",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const cfg = {
      ...baseCfg,
      session: {
        store: storePath,
      },
    } as unknown as OpenClawConfig;

    const policy = resolveSubagentToolPolicyForSession(cfg, "agent:main:subagent:flat-leaf");
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(false);
  });

  it("defaults to leaf behavior when no depth is provided", () => {
    const policy = resolveSubagentToolPolicy(baseCfg);
    // Default depth=1, maxSpawnDepth=2 → orchestrator
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("defaults to leaf behavior when depth is undefined and maxSpawnDepth is 1", () => {
    const policy = resolveSubagentToolPolicy(leafCfg);
    // Default depth=1, maxSpawnDepth=1 → leaf
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });
});

describe("resolveEffectiveToolPolicy", () => {
  it("implicitly re-exposes exec and process when tools.exec is configured", () => {
    const cfg = {
      tools: {
        profile: "messaging",
        exec: { host: "sandbox" },
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg });
    expect(result.profileAlsoAllow).toEqual(["exec", "process"]);
  });

  it("implicitly re-exposes read, write, and edit when tools.fs is configured", () => {
    const cfg = {
      tools: {
        profile: "messaging",
        fs: { workspaceOnly: false },
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg });
    expect(result.profileAlsoAllow).toEqual(["read", "write", "edit"]);
  });

  it("merges explicit alsoAllow with implicit tool-section exposure", () => {
    const cfg = {
      tools: {
        profile: "messaging",
        alsoAllow: ["web_search"],
        exec: { host: "sandbox" },
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg });
    expect(result.profileAlsoAllow).toEqual(["web_search", "exec", "process"]);
  });

  it("uses agent tool sections when resolving implicit exposure", () => {
    const cfg = {
      tools: {
        profile: "messaging",
      },
      agents: {
        list: [
          {
            id: "coder",
            tools: {
              fs: { workspaceOnly: true },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg, agentId: "coder" });
    expect(result.profileAlsoAllow).toEqual(["read", "write", "edit"]);
  });
});

describe("resolveGroupToolPolicy", () => {
  it("applies exact direct-message tool policies before wildcard dm policies", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "*": {
              tools: { allow: ["read"] },
            },
            "ou-owner": {
              tools: { allow: ["read", "exec"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:ou-owner",
        messageProvider: "feishu",
        senderId: "ou-owner",
      }),
    ).toEqual({ allow: ["read", "exec"] });

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:ou-member",
        messageProvider: "feishu",
        senderId: "ou-member",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("uses the session directId for dm entry matching and senderId for sender overrides", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "ou-shared": {
              tools: { allow: ["read"] },
              toolsBySender: {
                "id:ou-owner": { allow: ["read", "exec"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:ou-shared",
        messageProvider: "feishu",
        senderId: "ou-owner",
      }),
    ).toEqual({ allow: ["read", "exec"] });

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:ou-shared",
        messageProvider: "feishu",
        senderId: "ou-member",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("falls back to wildcard dm tools when a specific dm entry has no effective tools", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "*": {
              tools: { allow: ["read"] },
            },
            "ou-owner": {
              tools: {},
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:ou-owner",
        messageProvider: "feishu",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("falls back to dm tools when a sender-scoped dm override is empty", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "ou-owner": {
              tools: { allow: ["read"] },
              toolsBySender: {
                "id:ou-owner": {},
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:ou-owner",
        messageProvider: "feishu",
        senderId: "ou-owner",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("falls back from thread directIds to the parent directId", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "ou-owner": {
              tools: { allow: ["read"] },
              toolsBySender: {
                "id:ou-owner": { allow: ["read", "exec"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:ou-owner:thread:th_yyy",
        messageProvider: "feishu",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("skips empty thread-specific DM entries and keeps probing parent direct policies", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "*": {
              tools: { allow: ["read"] },
            },
            "ou-owner:thread:th_yyy": {},
            "ou-owner": {
              tools: { allow: ["read", "exec"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:ou-owner:thread:th_yyy",
        messageProvider: "feishu",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("checks parent direct sender overrides before wildcard sender fallback when senderId is omitted", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "ou-owner": {
              toolsBySender: {
                "*": { allow: ["read"] },
                "id:ou-owner": { allow: ["read", "exec"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:ou-owner:thread:th_yyy",
        messageProvider: "feishu",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("keeps id-based parent direct overrides ahead of name matches when senderId is omitted", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "ou-owner": {
              toolsBySender: {
                "name:alice": { allow: ["read"] },
                "id:ou-owner": { allow: ["read", "exec"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:ou-owner:thread:th_yyy",
        messageProvider: "feishu",
        senderName: "alice",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("prefers the full directId over the parent fallback when a thread token is part of the id", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "ou-owner:thread:abc": {
              tools: { allow: ["read"] },
              toolsBySender: {
                "id:ou-owner:thread:abc": { allow: ["read", "exec"] },
              },
            },
            "ou-owner": {
              tools: { allow: ["read"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:ou-owner:thread:abc",
        messageProvider: "feishu",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("resolves account-scoped dm session keys from the session key itself", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "*": {
              tools: { allow: ["read"] },
            },
          },
          accounts: {
            ops: {
              dms: {
                "ou-owner": {
                  tools: { allow: ["read", "exec"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:ops:direct:ou-owner",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("treats empty account-scoped dms as an explicit override over top-level wildcard dms", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "*": {
              tools: { allow: ["read", "exec"] },
            },
          },
          accounts: {
            ops: {
              dms: {},
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:ops:direct:ou-owner",
      }),
    ).toBeUndefined();
  });

  it("lets resolved account-scoped direct sessions inherit top-level dms when the account omits dms", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "ou-owner": {
              tools: { allow: ["read", "exec"] },
            },
          },
          accounts: {
            ops: {
              groups: {},
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:ops:direct:ou-owner",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("prefers account-scoped dm candidates when account ids are ambiguous with scope kinds", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "direct:ou-owner": {
              tools: { allow: ["read"] },
            },
          },
          accounts: {
            direct: {
              dms: {
                "ou-owner": {
                  tools: { allow: ["read", "exec"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:direct:ou-owner",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("prefers account-scoped dm candidates over higher-rank top-level sender matches", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "direct:ou-owner": {
              toolsBySender: {
                "id:sender-1": {
                  allow: ["read"],
                },
              },
            },
          },
          accounts: {
            direct: {
              dms: {
                "ou-owner": {
                  tools: { allow: ["read", "exec"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:direct:ou-owner",
        senderId: "sender-1",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("treats empty ambiguous account-scoped dms as explicit overrides over top-level dm matches", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "direct:ou-owner": {
              tools: { allow: ["read"] },
            },
          },
          accounts: {
            direct: {
              dms: {},
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:direct:ou-owner",
      }),
    ).toBeUndefined();
  });

  it("lets ambiguous account-scoped direct sessions inherit top-level dms when the account exists", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "direct:ou-owner": {
              tools: { allow: ["read", "exec"] },
            },
          },
          accounts: {
            direct: {
              groups: {},
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:direct:ou-owner",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("uses messageProvider or spawnedBy channel hints for per-peer direct session keys", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "ou-owner": {
              tools: { allow: ["read", "exec"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:direct:ou-owner",
        messageProvider: "feishu",
      }),
    ).toEqual({ allow: ["read", "exec"] });

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:direct:ou-owner",
        spawnedBy: "agent:main:feishu:direct:ou-owner",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("does not misparse direct ids prefixed with group as account-scoped sessions", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "group:abc": {
              tools: { allow: ["read", "exec"] },
            },
          },
          accounts: {
            direct: {
              groups: {
                abc: {
                  tools: { allow: ["read"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:group:abc",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("keeps explicit Feishu group matches ahead of ambiguous direct fallbacks", () => {
    const cfg = {
      channels: {
        feishu: {
          groups: {
            "*": {
              tools: { allow: ["read"] },
            },
            "DIRECT:ABC": {
              tools: { allow: ["read"] },
            },
          },
          accounts: {
            group: {
              dms: {
                abc: {
                  tools: { allow: ["read", "exec"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:group:direct:abc",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("falls back to direct policy for ambiguous group keys when only wildcard group rules exist", () => {
    const cfg = {
      channels: {
        feishu: {
          groups: {
            "*": {
              tools: { allow: ["read"] },
            },
          },
          accounts: {
            group: {
              dms: {
                abc: {
                  tools: { allow: ["read", "exec"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:group:direct:abc",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("does not let ambiguous account-derived direct probes read top-level dms when the account is absent", () => {
    const cfg = {
      channels: {
        feishu: {
          groups: {
            "*": {
              tools: { allow: ["read"] },
            },
          },
          dms: {
            abc: {
              tools: { allow: ["read", "exec"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:group:direct:abc",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("does not fall back to top-level dms for account-scoped direct session keys when the account is absent", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "ou-owner": {
              tools: { allow: ["read", "exec"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:ops:direct:ou-owner",
      }),
    ).toBeUndefined();
  });

  it("checks alternate account-scoped group candidates before settling on wildcard group policy", () => {
    const cfg = {
      channels: {
        feishu: {
          groups: {
            "*": {
              tools: { allow: ["read"] },
            },
          },
          accounts: {
            group: {
              groups: {
                abc: {
                  tools: { allow: ["read", "exec"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:group:group:abc",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("does not let unresolved account-derived group candidates override literal group ids", () => {
    const cfg = {
      channels: {
        feishu: {
          groups: {
            "group:abc": {
              tools: { allow: ["read"] },
            },
            abc: {
              tools: { allow: ["read", "exec"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:group:group:abc",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("does not let unresolved account-derived group candidates override wildcard group policy", () => {
    const cfg = {
      channels: {
        feishu: {
          groups: {
            "*": {
              tools: { allow: ["read"] },
            },
            abc: {
              tools: { allow: ["read", "exec"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:group:group:abc",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("does not give inherited top-level group matches account-scoped precedence when the account omits groups", () => {
    const cfg = {
      channels: {
        feishu: {
          groups: {
            "group:abc": {
              tools: { allow: ["read"] },
            },
            abc: {
              tools: { allow: ["read", "exec"] },
            },
          },
          accounts: {
            group: {},
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:group:group:abc",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("does not cross over from direct parsing into unrelated group policies", () => {
    const cfg = {
      channels: {
        feishu: {
          dms: {
            "*": {
              tools: { allow: ["read"] },
            },
          },
          accounts: {
            direct: {
              groups: {
                abc: {
                  tools: { allow: ["read", "exec"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:feishu:direct:group:abc",
      }),
    ).toEqual({ allow: ["read"] });
  });
});
