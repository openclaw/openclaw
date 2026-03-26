import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { TaskProfileId } from "./task-profile.js";
import { normalizeToolName } from "./tool-policy.js";

type DynamicToolPruningReport = NonNullable<SessionSystemPromptReport["toolPruning"]>;

const WEB_TOOL_NAMES = new Set(["browser", "web_search", "web_fetch"]);
const MESSAGING_TOOL_NAMES = new Set(["message", "sessions_send", "tts"]);
const OPS_TOOL_NAMES = new Set(["gateway", "cron", "nodes"]);
const READ_ONLY_MUTATION_TOOL_NAMES = new Set(["write", "edit", "apply_patch"]);

const WEB_SIGNAL_PATTERN =
  /\b(web|browser|url|website|online|internet|search(?: the)? web|web search|fetch(?: a| the)? (?:url|page|site)|visit)\b/i;
const MESSAGING_SIGNAL_PATTERN =
  /\b(reply|respond|message|send|notify|dm|email|sms|text back|tts|speak)\b/i;
const OPS_SIGNAL_PATTERN =
  /\b(gateway|cron|node|nodes|service|server|deploy|restart|healthcheck|health|log|logs|monitor)\b/i;
const READ_ONLY_HINT_PATTERN =
  /\b(read[- ]only|without changing|without modifications?|no code changes|do not (?:edit|modify|change|write|patch)|don't (?:edit|modify|change|write|patch)|just (?:explain|review|inspect|summari[sz]e|analy[sz]e))\b/i;
const READ_ONLY_VERB_PATTERN =
  /\b(explain|review|inspect|summari[sz]e|analy[sz]e|understand|trace|find|locate|show|describe)\b/i;
const WRITE_SIGNAL_PATTERN =
  /\b(fix|implement|edit|write|modify|change|create|add|remove|delete|refactor|rename|patch|run|test|build|lint|check|execute)\b/i;

function measureTool(tool: AnyAgentTool): { summaryChars: number; schemaChars: number } {
  const summaryChars = (tool.description?.trim() || tool.label?.trim() || "").length;
  const schemaChars = (() => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return 0;
    }
    try {
      return JSON.stringify(tool.parameters).length;
    } catch {
      return 0;
    }
  })();
  return { summaryChars, schemaChars };
}

function buildEmptyReport(): DynamicToolPruningReport {
  return {
    prunedCount: 0,
    prunedSummaryChars: 0,
    prunedSchemaChars: 0,
    entries: [],
  };
}

function looksReadOnlyPrompt(promptText: string): boolean {
  if (!promptText) {
    return false;
  }
  if (READ_ONLY_HINT_PATTERN.test(promptText)) {
    return true;
  }
  return READ_ONLY_VERB_PATTERN.test(promptText) && !WRITE_SIGNAL_PATTERN.test(promptText);
}

export function pruneToolsForPrompt(params: {
  tools: AnyAgentTool[];
  promptText?: string;
  taskProfile?: TaskProfileId;
}): {
  tools: AnyAgentTool[];
  report: DynamicToolPruningReport;
} {
  const promptText = params.promptText?.trim() ?? "";
  if (!promptText) {
    return { tools: params.tools, report: buildEmptyReport() };
  }

  const reportEntries: DynamicToolPruningReport["entries"] = [];
  const removedNames = new Set<string>();
  let filtered = params.tools;

  const applyRule = (toolNames: Set<string>, reason: string) => {
    filtered = filtered.filter((tool) => {
      const normalizedName = normalizeToolName(tool.name);
      if (!toolNames.has(normalizedName)) {
        return true;
      }
      if (!removedNames.has(normalizedName)) {
        removedNames.add(normalizedName);
        const cost = measureTool(tool);
        reportEntries.push({
          name: tool.name,
          reason,
          summaryChars: cost.summaryChars,
          schemaChars: cost.schemaChars,
        });
      }
      return false;
    });
  };

  if (params.taskProfile !== "research" && !WEB_SIGNAL_PATTERN.test(promptText)) {
    applyRule(WEB_TOOL_NAMES, "no explicit web or browser signal in prompt");
  }
  if (params.taskProfile !== "assistant" && !MESSAGING_SIGNAL_PATTERN.test(promptText)) {
    applyRule(MESSAGING_TOOL_NAMES, "no explicit messaging or reply signal in prompt");
  }
  if (params.taskProfile !== "ops" && !OPS_SIGNAL_PATTERN.test(promptText)) {
    applyRule(OPS_TOOL_NAMES, "no explicit runtime ops signal in prompt");
  }
  if (looksReadOnlyPrompt(promptText)) {
    applyRule(READ_ONLY_MUTATION_TOOL_NAMES, "prompt looks read-only; mutation tools skipped");
  }

  return {
    tools: filtered,
    report: {
      prunedCount: reportEntries.length,
      prunedSummaryChars: reportEntries.reduce((sum, entry) => sum + entry.summaryChars, 0),
      prunedSchemaChars: reportEntries.reduce((sum, entry) => sum + entry.schemaChars, 0),
      entries: reportEntries,
    },
  };
}
