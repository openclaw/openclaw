import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import {
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
  resolveMattermostPreviewStreamMode,
  resolveMattermostReplyToMode,
  resolveMattermostToolPreviewMode,
} from "./accounts.js";

describe("resolveDefaultMattermostAccountId", () => {
  it("prefers channels.mattermost.defaultAccount when it matches a configured account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          defaultAccount: "alerts",
          accounts: {
            default: { botToken: "tok-default", baseUrl: "https://chat.example.com" },
            alerts: { botToken: "tok-alerts", baseUrl: "https://alerts.example.com" },
          },
        },
      },
    };

    expect(resolveDefaultMattermostAccountId(cfg)).toBe("alerts");
  });

  it("normalizes channels.mattermost.defaultAccount before lookup", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          defaultAccount: "Ops Team",
          accounts: {
            "ops-team": { botToken: "tok-ops", baseUrl: "https://chat.example.com" },
          },
        },
      },
    };

    expect(resolveDefaultMattermostAccountId(cfg)).toBe("ops-team");
  });

  it("falls back when channels.mattermost.defaultAccount is missing", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          defaultAccount: "missing",
          accounts: {
            default: { botToken: "tok-default", baseUrl: "https://chat.example.com" },
            alerts: { botToken: "tok-alerts", baseUrl: "https://alerts.example.com" },
          },
        },
      },
    };

    expect(resolveDefaultMattermostAccountId(cfg)).toBe("default");
  });
});

describe("resolveMattermostReplyToMode", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          defaultAccount: "alerts",
          accounts: {
            alerts: {
              botToken: "tok-alerts",
              baseUrl: "https://alerts.example.com",
              replyToMode: "all",
            },
          },
        },
      },
    };

    const account = resolveMattermostAccount({ cfg });
    expect(account.accountId).toBe("alerts");
    expect(resolveMattermostReplyToMode(account, "channel")).toBe("all");
  });

  it("uses the configured mode for channel and group messages", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          replyToMode: "all",
        },
      },
    };

    const account = resolveMattermostAccount({ cfg, accountId: "default" });
    expect(resolveMattermostReplyToMode(account, "channel")).toBe("all");
    expect(resolveMattermostReplyToMode(account, "group")).toBe("all");
  });

  it("keeps direct messages off even when replyToMode is enabled", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          replyToMode: "all",
        },
      },
    };

    const account = resolveMattermostAccount({ cfg, accountId: "default" });
    expect(resolveMattermostReplyToMode(account, "direct")).toBe("off");
  });

  it("defaults to off when replyToMode is unset", () => {
    const account = resolveMattermostAccount({ cfg: {}, accountId: "default" });
    expect(resolveMattermostReplyToMode(account, "channel")).toBe("off");
  });

  it("preserves shared commands config when an account overrides one commands field", () => {
    const account = resolveMattermostAccount({
      cfg: {
        channels: {
          mattermost: {
            commands: {
              native: true,
            },
            accounts: {
              work: {
                commands: {
                  callbackPath: "/hooks/work",
                },
              },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(account.config.commands).toEqual({
      native: true,
      callbackPath: "/hooks/work",
    });
  });
});

describe("resolveMattermostPreviewStreamMode", () => {
  it("defaults to 'partial' when streaming.mode is not set", () => {
    expect(resolveMattermostPreviewStreamMode({})).toBe("partial");
  });

  it("returns 'block' when streaming.mode is explicitly 'block'", () => {
    expect(resolveMattermostPreviewStreamMode({ streaming: { mode: "block" } })).toBe("block");
  });

  it("returns 'partial' when streaming.mode is explicitly 'partial'", () => {
    expect(resolveMattermostPreviewStreamMode({ streaming: { mode: "partial" } })).toBe("partial");
  });

  it("falls back to default when streaming exists but mode is undefined", () => {
    expect(resolveMattermostPreviewStreamMode({ streaming: {} })).toBe("partial");
  });

  it("surfaces previewStreamMode through resolveMattermostAccount", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          streaming: { mode: "block" },
        },
      },
    };

    const account = resolveMattermostAccount({ cfg, accountId: "default" });
    expect(account.previewStreamMode).toBe("block");
  });

  it("defaults previewStreamMode to 'partial' when no streaming config is present", () => {
    const account = resolveMattermostAccount({ cfg: {}, accountId: "default" });
    expect(account.previewStreamMode).toBe("partial");
  });

  it("allows accounts to override channel-wide streaming.mode", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          streaming: { mode: "partial" },
          accounts: {
            alerts: {
              streaming: { mode: "block" },
            },
          },
        },
      },
    };

    const def = resolveMattermostAccount({ cfg, accountId: "default" });
    const alerts = resolveMattermostAccount({ cfg, accountId: "alerts" });
    expect(def.previewStreamMode).toBe("partial");
    expect(alerts.previewStreamMode).toBe("block");
  });
});

describe("resolveMattermostToolPreviewMode", () => {
  it("defaults to 'name' when streaming.toolPreview is not set", () => {
    expect(resolveMattermostToolPreviewMode({})).toBe("name");
  });

  it("returns 'args' when streaming.toolPreview is explicitly 'args'", () => {
    expect(resolveMattermostToolPreviewMode({ streaming: { toolPreview: "args" } })).toBe("args");
  });

  it("returns 'name' when streaming.toolPreview is explicitly 'name'", () => {
    expect(resolveMattermostToolPreviewMode({ streaming: { toolPreview: "name" } })).toBe("name");
  });

  it("falls back to default when streaming exists but toolPreview is undefined", () => {
    expect(resolveMattermostToolPreviewMode({ streaming: { mode: "block" } })).toBe("name");
  });

  it("surfaces toolPreviewMode through resolveMattermostAccount", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          streaming: { mode: "block", toolPreview: "args" },
        },
      },
    };

    const account = resolveMattermostAccount({ cfg, accountId: "default" });
    expect(account.previewStreamMode).toBe("block");
    expect(account.toolPreviewMode).toBe("args");
  });

  it("defaults toolPreviewMode to 'name' when no streaming config is present", () => {
    const account = resolveMattermostAccount({ cfg: {}, accountId: "default" });
    expect(account.toolPreviewMode).toBe("name");
  });

  it("allows accounts to override channel-wide streaming.toolPreview", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          streaming: { toolPreview: "name" },
          accounts: {
            verbose: {
              streaming: { toolPreview: "args" },
            },
          },
        },
      },
    };

    const def = resolveMattermostAccount({ cfg, accountId: "default" });
    const verbose = resolveMattermostAccount({ cfg, accountId: "verbose" });
    expect(def.toolPreviewMode).toBe("name");
    expect(verbose.toolPreviewMode).toBe("args");
  });
});
