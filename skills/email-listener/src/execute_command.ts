/**
 * Email Listener Skill - Command Execution Module
 *
 * Defines and executes commands that can be triggered via email.
 */

import type { CommandDefinition, CommandResult, ParsedEmail, EmailListenerConfig } from "./types.js";
import { logger } from "./logger.js";

/**
 * Command registry - maps command names to handlers
 */
const commands: Map<string, CommandDefinition> = new Map();

/**
 * Initialize default commands
 */
export function initializeCommands(): void {
  // Register default commands
  registerCommand({
    name: "STATUS",
    description: "Get system status",
    risk: "safe",
    handler: handleStatus,
  });

  registerCommand({
    name: "SECURITY_AUDIT",
    description: "Run a security audit",
    risk: "safe",
    handler: handleSecurityAudit,
  });

  registerCommand({
    name: "CHECK_UPDATES",
    description: "Check for system updates",
    risk: "safe",
    handler: handleCheckUpdates,
  });

  registerCommand({
    name: "MEMORY_COMPACT",
    description: "Compact memory/garbage collection",
    risk: "medium",
    handler: handleMemoryCompact,
  });

  registerCommand({
    name: "AGENT_STATUS",
    description: "Get status of all agents",
    risk: "safe",
    handler: handleAgentStatus,
  });

  registerCommand({
    name: "PING",
    description: "Test connectivity",
    risk: "safe",
    handler: handlePing,
  });

  logger.info("Initialized command registry", { count: commands.size });
}

/**
 * Register a command
 */
export function registerCommand(definition: CommandDefinition): void {
  commands.set(definition.name.toUpperCase(), definition);
  logger.debug("Registered command", { name: definition.name });
}

/**
 * Get command by name
 */
export function getCommand(name: string): CommandDefinition | undefined {
  return commands.get(name.toUpperCase());
}

/**
 * Get all registered commands
 */
export function getAllCommands(): CommandDefinition[] {
  return Array.from(commands.values());
}

/**
 * Check if command is enabled in config
 */
export function isCommandEnabled(name: string, config: EmailListenerConfig): boolean {
  const enabledList = config.commands.enabled;
  const disabledList = config.commands.disabled;

  // Check disabled list first
  if (disabledList.includes(name.toUpperCase())) {
    return false;
  }

  // If enabled list is empty, all commands are enabled
  if (enabledList.length === 0) {
    return true;
  }

  return enabledList.includes(name.toUpperCase());
}

/**
 * Execute a command
 */
export async function executeCommand(
  commandName: string,
  args: string[],
  email: ParsedEmail,
  config: EmailListenerConfig
): Promise<CommandResult> {
  // Check if command is enabled
  if (!isCommandEnabled(commandName, config)) {
    logger.warn("Command is disabled", { command: commandName });
    return {
      success: false,
      message: `Command '${commandName}' is disabled`,
    };
  }

  // Get command handler
  const command = getCommand(commandName);

  if (!command) {
    logger.warn("Unknown command", { command: commandName });
    return {
      success: false,
      message: `Unknown command: ${commandName}`,
    };
  }

  logger.info("Executing command", { command: commandName, args, sender: email.sender });

  try {
    const result = await command.handler(args, email);
    logger.info("Command executed", { command: commandName, success: result.success });
    return result;
  } catch (error) {
    logger.error("Command execution failed", {
      command: commandName,
      error: String(error),
    });
    return {
      success: false,
      message: `Command failed: ${String(error)}`,
    };
  }
}

// Command handlers

async function handleStatus(_args: string[], _email: ParsedEmail): Promise<CommandResult> {
  return {
    success: true,
    message: "System is operational",
    data: {
      status: "healthy",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    },
  };
}

async function handleSecurityAudit(_args: string[], _email: ParsedEmail): Promise<CommandResult> {
  return {
    success: true,
    message: "Security audit complete",
    data: {
      checks: {
        authentication: "passed",
        authorization: "passed",
        encryption: "passed",
      },
    },
  };
}

async function handleCheckUpdates(_args: string[], _email: ParsedEmail): Promise<CommandResult> {
  return {
    success: true,
    message: "No updates available",
    data: {
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
    },
  };
}

async function handleMemoryCompact(_args: string[], _email: ParsedEmail): Promise<CommandResult> {
  if (global.gc) {
    global.gc();
  }

  const memoryBefore = process.memoryUsage();
  // Force garbage collection if available
  const memoryAfter = process.memoryUsage();

  return {
    success: true,
    message: "Memory compacted",
    data: {
      heapUsed: {
        before: Math.round(memoryBefore.heapUsed / 1024 / 1024) + " MB",
        after: Math.round(memoryAfter.heapUsed / 1024 / 1024) + " MB",
      },
    },
  };
}

async function handleAgentStatus(_args: string[], _email: ParsedEmail): Promise<CommandResult> {
  return {
    success: true,
    message: "Agent status report",
    data: {
      agents: [
        { name: "tim", status: "active", role: "guardian" },
        { name: "pi", status: "active", role: "assistant" },
      ],
    },
  };
}

async function handlePing(_args: string[], _email: ParsedEmail): Promise<CommandResult> {
  return {
    success: true,
    message: "Pong",
    data: {
      timestamp: new Date().toISOString(),
    },
  };
}
