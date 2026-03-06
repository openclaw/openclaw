import { describe, expect, it } from "vitest";
import {
  applyRoleToSystemPrompt,
  BUILTIN_SUBAGENT_ROLES,
  getBuiltinRoleNames,
  getRoleDisplay,
  isBuiltinRole,
  resolveRoleConfig,
  resolveRoleModel,
  resolveRoleToolPolicy,
  SUBAGENT_ROLE_CODER,
  SUBAGENT_ROLE_REVIEWER,
  SUBAGENT_ROLE_PLANNER,
  SUBAGENT_ROLE_RESEARCHER,
  SUBAGENT_ROLE_DEBUGGER,
  SUBAGENT_ROLE_TESTER,
  SUBAGENT_ROLE_WRITER,
  SUBAGENT_ROLE_ANALYZER,
} from "./subagent-roles.js";

describe("subagent-roles", () => {
  describe("BUILTIN_SUBAGENT_ROLES", () => {
    it("defines all expected built-in roles", () => {
      expect(BUILTIN_SUBAGENT_ROLES).toHaveProperty("coder");
      expect(BUILTIN_SUBAGENT_ROLES).toHaveProperty("reviewer");
      expect(BUILTIN_SUBAGENT_ROLES).toHaveProperty("planner");
      expect(BUILTIN_SUBAGENT_ROLES).toHaveProperty("researcher");
      expect(BUILTIN_SUBAGENT_ROLES).toHaveProperty("debugger");
      expect(BUILTIN_SUBAGENT_ROLES).toHaveProperty("tester");
      expect(BUILTIN_SUBAGENT_ROLES).toHaveProperty("writer");
      expect(BUILTIN_SUBAGENT_ROLES).toHaveProperty("analyzer");
    });

    it("each role has required properties", () => {
      for (const [key, config] of Object.entries(BUILTIN_SUBAGENT_ROLES)) {
        expect(config.name).toBeTruthy();
        expect(config.description).toBeTruthy();
        expect(typeof config.name).toBe("string");
        expect(typeof config.description).toBe("string");
      }
    });
  });

  describe("resolveRoleConfig", () => {
    it("returns undefined when no role is specified", () => {
      expect(resolveRoleConfig()).toBeUndefined();
      expect(resolveRoleConfig(undefined)).toBeUndefined();
      expect(resolveRoleConfig("")).toBeUndefined();
    });

    it("returns built-in role config for known roles", () => {
      const config = resolveRoleConfig("coder");
      expect(config).toBeDefined();
      expect(config?.name).toBe("Coder");
      expect(config?.description).toContain("code");
    });

    it("returns minimal config for unknown custom role", () => {
      const config = resolveRoleConfig("custom-role");
      expect(config).toBeDefined();
      expect(config?.name).toBe("custom-role");
      expect(config?.description).toContain("custom-role");
    });

    it("merges custom config with built-in role", () => {
      const config = resolveRoleConfig("coder", {
        preferredModel: "custom-model",
        defaultTimeoutSeconds: 300,
      });
      expect(config).toBeDefined();
      expect(config?.name).toBe("Coder"); // From built-in
      expect(config?.preferredModel).toBe("custom-model"); // Overridden
      expect(config?.defaultTimeoutSeconds).toBe(300); // Added
    });

    it("uses custom config for unknown role", () => {
      const config = resolveRoleConfig("my-custom", {
        name: "My Custom Role",
        description: "A custom role for testing",
        toolAllowlist: ["read", "bash"],
      });
      expect(config).toBeDefined();
      expect(config?.name).toBe("My Custom Role");
      expect(config?.description).toBe("A custom role for testing");
      expect(config?.toolAllowlist).toEqual(["read", "bash"]);
    });
  });

  describe("applyRoleToSystemPrompt", () => {
    it("returns base prompt when no role config", () => {
      const basePrompt = "You are a helpful assistant.";
      expect(applyRoleToSystemPrompt(basePrompt)).toBe(basePrompt);
      expect(applyRoleToSystemPrompt(basePrompt, undefined)).toBe(basePrompt);
    });

    it("appends role information to base prompt", () => {
      const basePrompt = "You are a helpful assistant.";
      const config = resolveRoleConfig("coder");
      const result = applyRoleToSystemPrompt(basePrompt, config);

      expect(result).toContain(basePrompt);
      expect(result).toContain("## Role: Coder");
      expect(result).toContain("coding specialist");
    });

    it("includes system prompt suffix when present", () => {
      const basePrompt = "Base prompt.";
      const config = resolveRoleConfig("reviewer");
      const result = applyRoleToSystemPrompt(basePrompt, config);

      expect(result).toContain("code reviewer");
      expect(result).toContain("code quality");
    });
  });

  describe("resolveRoleToolPolicy", () => {
    it("returns empty object when no role config", () => {
      expect(resolveRoleToolPolicy()).toEqual({});
      expect(resolveRoleToolPolicy(undefined)).toEqual({});
    });

    it("returns allow and deny lists from role config", () => {
      const config = resolveRoleConfig("coder");
      const policy = resolveRoleToolPolicy(config);

      expect(policy.allow).toBeDefined();
      expect(policy.allow).toContain("bash");
      expect(policy.allow).toContain("read");
      expect(policy.allow).toContain("write");
    });

    it("reviewer role has write in deny list", () => {
      const config = resolveRoleConfig("reviewer");
      const policy = resolveRoleToolPolicy(config);

      expect(policy.deny).toBeDefined();
      expect(policy.deny).toContain("write");
      expect(policy.deny).toContain("edit");
    });
  });

  describe("resolveRoleModel", () => {
    it("returns default model when no role config", () => {
      expect(resolveRoleModel(undefined, "default-model")).toBe("default-model");
    });

    it("returns role preferred model when specified", () => {
      const config = resolveRoleConfig("coder");
      const model = resolveRoleModel(config, "default-model");

      expect(model).toBeDefined();
      // coder has preferredModel set
      expect(model).not.toBe("default-model");
    });

    it("combines provider and model when both are specified", () => {
      const config = resolveRoleConfig("coder");
      const model = resolveRoleModel(config);

      // Should be in provider/model format
      expect(model).toContain("/");
    });
  });

  describe("isBuiltinRole", () => {
    it("returns true for built-in roles", () => {
      expect(isBuiltinRole("coder")).toBe(true);
      expect(isBuiltinRole("reviewer")).toBe(true);
      expect(isBuiltinRole("planner")).toBe(true);
    });

    it("returns false for custom roles", () => {
      expect(isBuiltinRole("custom-role")).toBe(false);
      expect(isBuiltinRole("my-special-agent")).toBe(false);
    });
  });

  describe("getBuiltinRoleNames", () => {
    it("returns all built-in role names", () => {
      const names = getBuiltinRoleNames();

      expect(names).toContain("coder");
      expect(names).toContain("reviewer");
      expect(names).toContain("planner");
      expect(names).toContain("researcher");
      expect(names).toContain("debugger");
      expect(names).toContain("tester");
      expect(names).toContain("writer");
      expect(names).toContain("analyzer");
      expect(names.length).toBe(8);
    });
  });

  describe("getRoleDisplay", () => {
    it("returns undefined when no role specified", () => {
      expect(getRoleDisplay()).toBeUndefined();
      expect(getRoleDisplay(undefined)).toBeUndefined();
    });

    it("returns display info for built-in role", () => {
      const display = getRoleDisplay("coder");

      expect(display).toBeDefined();
      expect(display?.name).toBe("Coder");
      expect(display?.description).toBeTruthy();
      expect(display?.icon).toBe("💻");
    });

    it("returns display info for custom role", () => {
      const display = getRoleDisplay("my-custom");

      expect(display).toBeDefined();
      expect(display?.name).toBe("my-custom");
      expect(display?.description).toContain("Custom role");
    });
  });

  describe("role constants", () => {
    it("exports correct role constants", () => {
      expect(SUBAGENT_ROLE_CODER).toBe("coder");
      expect(SUBAGENT_ROLE_REVIEWER).toBe("reviewer");
      expect(SUBAGENT_ROLE_PLANNER).toBe("planner");
      expect(SUBAGENT_ROLE_RESEARCHER).toBe("researcher");
      expect(SUBAGENT_ROLE_DEBUGGER).toBe("debugger");
      expect(SUBAGENT_ROLE_TESTER).toBe("tester");
      expect(SUBAGENT_ROLE_WRITER).toBe("writer");
      expect(SUBAGENT_ROLE_ANALYZER).toBe("analyzer");
    });
  });

  describe("role-specific configurations", () => {
    it("coder role allows write and edit tools", () => {
      const config = resolveRoleConfig("coder");
      expect(config?.toolAllowlist).toContain("write");
      expect(config?.toolAllowlist).toContain("edit");
    });

    it("reviewer role denies write and edit tools", () => {
      const config = resolveRoleConfig("reviewer");
      expect(config?.toolDenylist).toContain("write");
      expect(config?.toolDenylist).toContain("edit");
      expect(config?.readOnlyHint).toBe(true);
    });

    it("planner role has read-only hint", () => {
      const config = resolveRoleConfig("planner");
      expect(config?.readOnlyHint).toBe(true);
    });

    it("researcher role allows web tools", () => {
      const config = resolveRoleConfig("researcher");
      expect(config?.toolAllowlist).toContain("web_search");
      expect(config?.toolAllowlist).toContain("web_fetch");
    });

    it("debugger role allows edit tool", () => {
      const config = resolveRoleConfig("debugger");
      expect(config?.toolAllowlist).toContain("edit");
    });

    it("tester role allows write and edit tools", () => {
      const config = resolveRoleConfig("tester");
      expect(config?.toolAllowlist).toContain("write");
      expect(config?.toolAllowlist).toContain("edit");
    });
  });
});
