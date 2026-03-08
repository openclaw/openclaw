/**
 * Tests for command parsing (wecom/commands.js)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractLeadingSlashCommand,
  isHighPriorityCommand,
  checkCommandAllowlist,
  getCommandConfig,
  getWecomAdminUsers,
  isWecomAdmin,
} from "../wecom/commands.js";

// ── extractLeadingSlashCommand ────────────────────────────────────────────────

describe("extractLeadingSlashCommand", () => {
  it("extracts /new from '/new'", () => {
    assert.equal(extractLeadingSlashCommand("/new"), "/new");
  });

  it("extracts the command from '/help some args'", () => {
    assert.equal(extractLeadingSlashCommand("/help some args"), "/help");
  });

  it("returns null for plain text (no slash)", () => {
    assert.equal(extractLeadingSlashCommand("hello world"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(extractLeadingSlashCommand(""), null);
  });

  it("returns null for null input", () => {
    assert.equal(extractLeadingSlashCommand(null), null);
  });

  it("normalises command to lowercase", () => {
    assert.equal(extractLeadingSlashCommand("/NEW"), "/new");
    assert.equal(extractLeadingSlashCommand("/Stop"), "/stop");
  });

  it("trims leading whitespace before checking for slash", () => {
    assert.equal(extractLeadingSlashCommand("  /new"), "/new");
  });

  it("handles tab and multiple spaces as word separator", () => {
    assert.equal(extractLeadingSlashCommand("/compact\targument"), "/compact");
  });
});

// ── isHighPriorityCommand ─────────────────────────────────────────────────────

describe("isHighPriorityCommand", () => {
  it("returns true for /stop", () => {
    assert.equal(isHighPriorityCommand("/stop"), true);
  });

  it("returns true for /new", () => {
    assert.equal(isHighPriorityCommand("/new"), true);
  });

  it("returns false for /help", () => {
    assert.equal(isHighPriorityCommand("/help"), false);
  });

  it("returns false for /compact", () => {
    assert.equal(isHighPriorityCommand("/compact"), false);
  });

  it("returns false for null", () => {
    assert.equal(isHighPriorityCommand(null), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isHighPriorityCommand(""), false);
  });

  it("is case-insensitive", () => {
    assert.equal(isHighPriorityCommand("/STOP"), true);
    assert.equal(isHighPriorityCommand("/NEW"), true);
  });
});

// ── checkCommandAllowlist ─────────────────────────────────────────────────────

describe("checkCommandAllowlist — non-command messages", () => {
  it("returns isCommand=false, allowed=true for plain text", () => {
    const result = checkCommandAllowlist("hello", {});
    assert.equal(result.isCommand, false);
    assert.equal(result.allowed, true);
    assert.equal(result.command, null);
  });

  it("treats empty string as non-command", () => {
    const result = checkCommandAllowlist("", {});
    assert.equal(result.isCommand, false);
    assert.equal(result.allowed, true);
  });
});

describe("checkCommandAllowlist — default allowlist", () => {
  it("allows /new (in default allowlist)", () => {
    const result = checkCommandAllowlist("/new", {});
    assert.equal(result.isCommand, true);
    assert.equal(result.allowed, true);
    assert.equal(result.command, "/new");
  });

  it("allows /help (in default allowlist)", () => {
    const result = checkCommandAllowlist("/help", {});
    assert.equal(result.isCommand, true);
    assert.equal(result.allowed, true);
  });

  it("blocks /stop (not in default allowlist)", () => {
    const result = checkCommandAllowlist("/stop", {});
    assert.equal(result.isCommand, true);
    assert.equal(result.allowed, false);
  });

  it("blocks unknown commands", () => {
    const result = checkCommandAllowlist("/unknown-cmd", {});
    assert.equal(result.isCommand, true);
    assert.equal(result.allowed, false);
  });
});

describe("checkCommandAllowlist — custom allowlist config", () => {
  it("allows commands in a custom allowlist", () => {
    const config = {
      channels: {
        wecom: {
          commands: { allowlist: ["/custom", "/another"] },
        },
      },
    };
    assert.equal(checkCommandAllowlist("/custom", config).allowed, true);
    assert.equal(checkCommandAllowlist("/another", config).allowed, true);
    assert.equal(checkCommandAllowlist("/new", config).allowed, false);
  });

  it("allows all commands when enabled:false", () => {
    const config = {
      channels: { wecom: { commands: { enabled: false } } },
    };
    const result = checkCommandAllowlist("/anything-at-all", config);
    assert.equal(result.isCommand, true);
    assert.equal(result.allowed, true);
  });
});

// ── getCommandConfig ──────────────────────────────────────────────────────────

describe("getCommandConfig", () => {
  it("returns defaults when no config provided", () => {
    const cfg = getCommandConfig({});
    assert.ok(Array.isArray(cfg.allowlist));
    assert.ok(cfg.allowlist.length > 0);
    assert.equal(cfg.enabled, true);
    assert.ok(typeof cfg.blockMessage === "string");
  });

  it("merges custom allowlist", () => {
    const cfg = getCommandConfig({
      commands: { allowlist: ["/x"] },
    });
    assert.deepEqual(cfg.allowlist, ["/x"]);
  });
});

// ── getWecomAdminUsers / isWecomAdmin ─────────────────────────────────────────

describe("getWecomAdminUsers", () => {
  it("returns empty array when adminUsers is not set", () => {
    assert.deepEqual(getWecomAdminUsers({}), []);
  });

  it("returns normalised (lowercase, trimmed) user IDs", () => {
    const config = { adminUsers: ["Alice", " BOB ", "charlie"] };
    const admins = getWecomAdminUsers(config);
    assert.deepEqual(admins, ["alice", "bob", "charlie"]);
  });

  it("filters out empty/null entries", () => {
    const config = { adminUsers: ["user1", "", null, "user2"] };
    assert.deepEqual(getWecomAdminUsers(config), ["user1", "user2"]);
  });
});

describe("isWecomAdmin", () => {
  const config = { adminUsers: ["Admin1", "Admin2"] };

  it("returns true for a known admin user (case-insensitive)", () => {
    assert.equal(isWecomAdmin("ADMIN1", config), true);
    assert.equal(isWecomAdmin("admin2", config), true);
  });

  it("returns false for non-admin users", () => {
    assert.equal(isWecomAdmin("regular-user", config), false);
  });

  it("returns false when userId is falsy", () => {
    assert.equal(isWecomAdmin(null, config), false);
    assert.equal(isWecomAdmin("", config), false);
  });

  it("returns false when admin list is empty", () => {
    assert.equal(isWecomAdmin("someone", {}), false);
  });
});
