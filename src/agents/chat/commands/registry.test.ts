import { describe, it, expect } from "vitest";
import {
  registerCommand,
  getCommand,
  listCommands,
  isCommand,
  parseCommand,
  getCommandHelp,
  getAllCommandsHelp,
  type CommandDefinition,
} from "./registry.js";

describe("command registry", () => {
  describe("isCommand", () => {
    it("should return true for messages starting with /", () => {
      expect(isCommand("/help")).toBe(true);
      expect(isCommand("/invite @agent")).toBe(true);
      expect(isCommand("  /topic new topic")).toBe(true);
    });

    it("should return false for regular messages", () => {
      expect(isCommand("Hello world")).toBe(false);
      expect(isCommand("This is not /a command")).toBe(false);
      expect(isCommand("")).toBe(false);
    });
  });

  describe("parseCommand", () => {
    it("should parse command without arguments", () => {
      const result = parseCommand("/help");
      expect(result).toEqual({
        name: "help",
        args: [],
        rawArgs: "",
      });
    });

    it("should parse command with single argument", () => {
      const result = parseCommand("/topic New topic here");
      expect(result).toEqual({
        name: "topic",
        args: ["New", "topic", "here"],
        rawArgs: "New topic here",
      });
    });

    it("should parse quoted arguments", () => {
      const result = parseCommand('/topic "New topic with spaces"');
      expect(result).toEqual({
        name: "topic",
        args: ["New topic with spaces"],
        rawArgs: '"New topic with spaces"',
      });
    });

    it("should parse mixed quoted and unquoted arguments", () => {
      const result = parseCommand('/invite @agent "Custom Name"');
      expect(result).toEqual({
        name: "invite",
        args: ["@agent", "Custom Name"],
        rawArgs: '@agent "Custom Name"',
      });
    });

    it("should handle single quotes", () => {
      const result = parseCommand("/topic 'Single quoted'");
      expect(result?.args).toContain("Single quoted");
    });

    it("should return null for non-commands", () => {
      expect(parseCommand("Hello world")).toBeNull();
      expect(parseCommand("")).toBeNull();
    });

    it("should lowercase command names", () => {
      const result = parseCommand("/HELP");
      expect(result?.name).toBe("help");
    });
  });

  describe("registerCommand and getCommand", () => {
    it("should register and retrieve a command", () => {
      const testCommand: CommandDefinition = {
        name: "test-cmd",
        description: "Test command",
        usage: "/test-cmd",
        handler: async () => ({ success: true }),
      };

      registerCommand(testCommand);
      const retrieved = getCommand("test-cmd");
      expect(retrieved).toBe(testCommand);
    });

    it("should retrieve command by alias", () => {
      const testCommand: CommandDefinition = {
        name: "test-alias",
        aliases: ["ta", "testalias"],
        description: "Test command with aliases",
        usage: "/test-alias",
        handler: async () => ({ success: true }),
      };

      registerCommand(testCommand);
      expect(getCommand("ta")).toBe(testCommand);
      expect(getCommand("testalias")).toBe(testCommand);
    });

    it("should return undefined for unknown commands", () => {
      expect(getCommand("unknown-command-xyz")).toBeUndefined();
    });
  });

  describe("listCommands", () => {
    it("should return array of registered commands", () => {
      const commands = listCommands();
      expect(Array.isArray(commands)).toBe(true);
    });
  });

  describe("getCommandHelp", () => {
    it("should return help text for existing command", () => {
      const testCommand: CommandDefinition = {
        name: "help-test",
        description: "A test command",
        usage: "/help-test [arg]",
        examples: ["/help-test example"],
        requiredPermission: "send_messages",
        handler: async () => ({ success: true }),
      };

      registerCommand(testCommand);
      const help = getCommandHelp("help-test");

      expect(help).toContain("/help-test");
      expect(help).toContain("A test command");
      expect(help).toContain("/help-test [arg]");
      expect(help).toContain("/help-test example");
      expect(help).toContain("send_messages");
    });

    it("should return null for unknown command", () => {
      expect(getCommandHelp("nonexistent-command")).toBeNull();
    });
  });

  describe("getAllCommandsHelp", () => {
    it("should return formatted help for all commands", () => {
      const help = getAllCommandsHelp();
      expect(help).toContain("Available Commands");
      expect(help).toContain("/help");
    });
  });
});
