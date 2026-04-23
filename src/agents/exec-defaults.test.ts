import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import * as execApprovals from "../infra/exec-approvals.js";
import { canExecRequestNode, resolveExecDefaults } from "./exec-defaults.js";

describe("resolveExecDefaults", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(execApprovals, "loadExecApprovals").mockReturnValue({
      version: 1,
      agents: {},
    });
  });

  it("does not advertise node routing when exec host is pinned to gateway", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "gateway",
            },
          },
        },
        sandboxAvailable: false,
      }).canRequestNode,
    ).toBe(false);
  });

  it("does not advertise node routing when exec host is auto and sandbox is available", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "auto",
            },
          },
        },
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      host: "auto",
      effectiveHost: "sandbox",
      canRequestNode: false,
    });
  });

  it("keeps node routing available when exec host is auto without sandbox", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "auto",
            },
          },
        },
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      host: "auto",
      effectiveHost: "gateway",
      canRequestNode: true,
    });
  });

  it("honors session-level exec host overrides", () => {
    const sessionEntry = {
      execHost: "node",
    } as SessionEntry;
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "gateway",
            },
          },
        },
        sessionEntry,
        sandboxAvailable: false,
      }).canRequestNode,
    ).toBe(true);
  });

  it("uses host approval defaults for gateway when exec policy is unset", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "auto",
            },
          },
        },
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      host: "auto",
      effectiveHost: "gateway",
      mode: "full",
      security: "full",
      ask: "off",
    });
  });

  it("keeps sandbox deny by default when auto resolves to sandbox", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "auto",
            },
          },
        },
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      host: "auto",
      effectiveHost: "sandbox",
      mode: "deny",
      security: "deny",
      ask: "off",
    });
  });

  it("maps explicit exec auto mode to approval-miss policy", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              mode: "auto",
              security: "full",
              ask: "off",
            },
          },
        },
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      mode: "auto",
      security: "allowlist",
      ask: "on-miss",
    });
  });

  it("lets session legacy policy override global exec mode", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
        },
        sessionEntry: {
          execSecurity: "full",
          execAsk: "off",
        } as SessionEntry,
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      mode: "full",
      security: "full",
      ask: "off",
    });
  });

  it("lets agent legacy policy override global exec mode", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
          agents: {
            list: [
              {
                id: "runner",
                tools: {
                  exec: {
                    security: "full",
                    ask: "off",
                  },
                },
              },
            ],
          },
        },
        agentId: "runner",
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      mode: "full",
      security: "full",
      ask: "off",
    });
  });

  it("blocks node advertising in helper calls when sandbox is available", () => {
    expect(
      canExecRequestNode({
        cfg: {
          tools: {
            exec: {
              host: "auto",
            },
          },
        },
        sandboxAvailable: true,
      }),
    ).toBe(false);
  });
});
