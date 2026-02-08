import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getDmHistoryLimitFromSessionKey } from "./pi-embedded-runner.js";

describe("getDmHistoryLimitFromSessionKey - group sessions", () => {
  it("returns groupHistoryLimit for group sessions", () => {
    const config = {
      channels: {
        whatsapp: {
          groupHistoryLimit: 10,
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("whatsapp:group:120363419710760769@g.us", config)).toBe(
      10,
    );
  });

  it("returns groupHistoryLimit for agent-prefixed group sessions", () => {
    const config = {
      channels: {
        telegram: {
          groupHistoryLimit: 15,
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("agent:main:telegram:group:123456", config)).toBe(15);
  });

  it("returns per-group override when configured", () => {
    const config = {
      channels: {
        whatsapp: {
          groupHistoryLimit: 10,
          groups: {
            "120363419710760769@g.us": {
              historyLimit: 5,
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("whatsapp:group:120363419710760769@g.us", config)).toBe(
      5,
    );
  });

  it("returns per-group override for agent-prefixed keys", () => {
    const config = {
      channels: {
        telegram: {
          groupHistoryLimit: 20,
          groups: {
            "789": {
              historyLimit: 3,
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("agent:main:telegram:group:789", config)).toBe(3);
  });

  it("falls back to provider default when per-group not set", () => {
    const config = {
      channels: {
        whatsapp: {
          groupHistoryLimit: 12,
          groups: {
            "other-group": {
              historyLimit: 5,
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("whatsapp:group:120363419710760769@g.us", config)).toBe(
      12,
    );
  });

  it("returns undefined when groupHistoryLimit is not set", () => {
    const config = {
      channels: {
        whatsapp: {
          groups: {
            "123": {},
          },
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("whatsapp:group:123", config)).toBeUndefined();
  });

  it("returns 0 when per-group historyLimit is explicitly 0 (unlimited)", () => {
    const config = {
      channels: {
        telegram: {
          groupHistoryLimit: 15,
          groups: {
            "123": {
              historyLimit: 0,
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:group:123", config)).toBe(0);
  });

  it("returns undefined for non-dm and non-group session kinds", () => {
    const config = {
      channels: {
        whatsapp: {
          dmHistoryLimit: 10,
          groupHistoryLimit: 20,
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("whatsapp:channel:123", config)).toBeUndefined();
    expect(getDmHistoryLimitFromSessionKey("whatsapp:unknown:456", config)).toBeUndefined();
  });

  it("handles group IDs with colons (e.g., email-like formats)", () => {
    const config = {
      channels: {
        msteams: {
          groupHistoryLimit: 10,
          groups: {
            "group:with:colons": {
              historyLimit: 7,
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("msteams:group:group:with:colons", config)).toBe(7);
  });

  it("DM and group limits are independent", () => {
    const config = {
      channels: {
        whatsapp: {
          dmHistoryLimit: 50,
          groupHistoryLimit: 10,
        },
      },
    } as OpenClawConfig;
    expect(getDmHistoryLimitFromSessionKey("whatsapp:dm:123", config)).toBe(50);
    expect(getDmHistoryLimitFromSessionKey("whatsapp:group:456", config)).toBe(10);
  });
});
