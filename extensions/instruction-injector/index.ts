/**
 * Instruction Injector Plugin
 *
 * Injects custom instructions into every agent session via the system prompt.
 * Instructions can be provided inline via config or loaded from a file.
 *
 * Use cases:
 * - Custom protocols (task tracking, code review requirements, etc.)
 * - Team-specific guidelines
 * - Project-specific context
 * - Safety/compliance instructions
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type InstructionInjectorConfig = {
  instructions?: string;
  file?: string;
  position?: "prepend" | "append";
  wrapWithHeader?: boolean;
  headerTitle?: string;
};

function expandPath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

async function loadInstructions(config: InstructionInjectorConfig): Promise<string | null> {
  // File takes precedence over inline
  if (config.file) {
    try {
      const filePath = expandPath(config.file);
      const content = await fs.readFile(filePath, "utf-8");
      return content.trim();
    } catch (err) {
      console.error(`[instruction-injector] Failed to load file: ${config.file}`, err);
      return null;
    }
  }

  if (config.instructions) {
    return config.instructions.trim();
  }

  return null;
}

function wrapInstructions(instructions: string, wrap: boolean, title: string): string {
  if (!wrap) {
    return instructions;
  }

  return `## ${title}

${instructions}`;
}

const plugin = {
  id: "instruction-injector",
  name: "Instruction Injector",
  description: "Inject custom instructions into agent system prompt",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as InstructionInjectorConfig | undefined;

    if (!config?.instructions && !config?.file) {
      api.logger.warn(
        "[instruction-injector] No instructions configured. Set 'instructions' or 'file' in plugin config.",
      );
      return;
    }

    const position = config.position ?? "prepend";
    const wrapWithHeader = config.wrapWithHeader ?? true;
    const headerTitle = config.headerTitle ?? "Custom Instructions";

    api.logger.info(
      `Instruction injector enabled (source: ${config.file ? "file" : "inline"}, position: ${position})`,
    );

    // Cache loaded instructions to avoid file reads on every request
    let cachedInstructions: string | null = null;
    let instructionsLoaded = false;

    api.on("before_agent_start", async () => {
      // Load instructions on first use
      if (!instructionsLoaded) {
        cachedInstructions = await loadInstructions(config);
        instructionsLoaded = true;

        if (!cachedInstructions) {
          api.logger.warn("[instruction-injector] No instructions loaded");
        }
      }

      if (!cachedInstructions) {
        return undefined;
      }

      const formatted = wrapInstructions(cachedInstructions, wrapWithHeader, headerTitle);

      if (position === "append") {
        // Note: prependContext is the only option currently available
        // For true append, would need systemPrompt modification
        return { prependContext: formatted };
      }

      return { prependContext: formatted };
    });
  },
};

export default plugin;
