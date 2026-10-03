/**
 * Realtime bootstrap context loader.
 *
 * Voice/realtime sessions use this to inject selected profile files into model
 * instructions with deterministic ordering and a hard character budget.
 */
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { root } from "../infra/fs-safe.js";
import { resolveUserPath, truncateUtf16Safe } from "../utils.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";
import { resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import { buildBootstrapContextFiles } from "./embedded-agent-helpers.js";
import { resolveAgentIdentity } from "./identity.js";
import {
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_USER_FILENAME,
} from "./workspace.js";

const REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS =
  "Agent context: You speak for an OpenClaw agent that can run many sessions at once, such as direct chats, channel conversations, background work, subagents, and scheduled jobs. This voice call is attached to one of those sessions. You cannot see the other sessions directly, but they belong to the same agent, so never claim you are only in this conversation, have no other work, or are not the one running it. For questions about other sessions, what is running, progress, or priorities, delegate to OpenClaw instead of guessing.";

/** Default ordered profile files included in realtime bootstrap context. */
export const REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES = [
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_SOUL_FILENAME,
] as const;

/** Default profile file names resolved through the agent bootstrap pipeline. */
export type RealtimeBootstrapContextFileName =
  (typeof REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES)[number];

const REALTIME_BOOTSTRAP_CONTEXT_FILE_NAME_SET: ReadonlySet<string> = new Set(
  REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES,
);
const DEFAULT_REALTIME_BOOTSTRAP_CONTEXT_MAX_CHARS = 12_000;
const REALTIME_BOOTSTRAP_CONTEXT_TITLE = "OpenClaw realtime voice profile context:";
const REALTIME_BOOTSTRAP_CONTEXT_GUIDANCE =
  "Use these profile files for identity, persona, and user grounding; do not mention them unless asked.";

function isRealtimeBootstrapContextFileName(
  value: string,
): value is RealtimeBootstrapContextFileName {
  return REALTIME_BOOTSTRAP_CONTEXT_FILE_NAME_SET.has(value);
}

function formatRealtimeBootstrapContextFileName(pathValue: string): string {
  return path.basename(pathValue.trim().replace(/\\/g, "/"));
}

/** Builds bounded realtime instructions from selected profile bootstrap files. */
export async function resolveRealtimeBootstrapContextInstructions(params: {
  agentId: string;
  config: OpenClawConfig;
  files?: readonly string[];
  maxChars?: number;
  sessionKey?: string;
  warn?: (message: string) => void;
}): Promise<string | undefined> {
  const requestedFiles = params.files ?? REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES;
  if (requestedFiles.length === 0) {
    return undefined;
  }
  const requestedOrder = new Map(requestedFiles.map((fileName, index) => [fileName, index]));
  const workspaceDir = resolveUserPath(resolveAgentWorkspaceDir(params.config, params.agentId));
  const bootstrapFiles = requestedFiles.some(isRealtimeBootstrapContextFileName)
    ? await resolveBootstrapFilesForRun({
        workspaceDir,
        config: params.config,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        warn: params.warn,
      })
    : [];
  const selectedFiles: Parameters<typeof buildBootstrapContextFiles>[0] = bootstrapFiles.filter(
    (file) =>
      !file.missing &&
      isRealtimeBootstrapContextFileName(file.name) &&
      requestedOrder.has(file.name),
  );
  const extraFiles = [...requestedOrder.keys()].filter(
    (fileName) => !isRealtimeBootstrapContextFileName(fileName),
  );
  if (extraFiles.length > 0) {
    const workspaceRoot = await root(workspaceDir).catch((error: unknown) => {
      params.warn?.(`realtime workspace context unavailable: ${String(error)}`);
      return undefined;
    });
    if (workspaceRoot) {
      for (const fileName of extraFiles) {
        try {
          const content = await workspaceRoot.readText(fileName);
          if (content.trim()) {
            selectedFiles.push({ name: fileName, path: fileName, content, missing: false });
          }
        } catch (error) {
          params.warn?.(`skipping realtime context file "${fileName}": ${String(error)}`);
        }
      }
    }
  }
  selectedFiles.sort((left, right) => {
    // Preserve requested profile-file order, then path-sort duplicate sources.
    const leftOrder = requestedOrder.get(left.name) ?? 0;
    const rightOrder = requestedOrder.get(right.name) ?? 0;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.path.localeCompare(right.path);
  });
  if (selectedFiles.length === 0) {
    return undefined;
  }

  const totalMaxChars = params.maxChars ?? DEFAULT_REALTIME_BOOTSTRAP_CONTEXT_MAX_CHARS;
  const preamble = [REALTIME_BOOTSTRAP_CONTEXT_TITLE, REALTIME_BOOTSTRAP_CONTEXT_GUIDANCE].join(
    "\n",
  );
  const fileNames = selectedFiles.map((file) => formatRealtimeBootstrapContextFileName(file.path));
  const contentBudget =
    totalMaxChars -
    preamble.length -
    "\n\n".length * fileNames.length -
    fileNames.reduce((total, fileName) => total + `### ${fileName}\n`.length, 0);
  if (contentBudget <= 0) {
    params.warn?.(
      `realtime bootstrap context budget is too small to include selected profile files (limit ${totalMaxChars})`,
    );
    return undefined;
  }
  // Divide the remaining budget evenly; buildBootstrapContextFiles enforces
  // both per-file and aggregate UTF-16-safe truncation.
  const perFileMaxChars = Math.max(1, Math.floor(contentBudget / selectedFiles.length));
  const contextFiles = buildBootstrapContextFiles(selectedFiles, {
    maxChars: perFileMaxChars,
    totalMaxChars: contentBudget,
    warn: params.warn,
  });
  if (contextFiles.length === 0) {
    return undefined;
  }

  const instructions = [
    preamble,
    ...contextFiles.map(
      (file) =>
        `### ${formatRealtimeBootstrapContextFileName(file.path)}\n${file.content.trimEnd()}`,
    ),
  ].join("\n\n");
  return instructions.length <= totalMaxChars
    ? instructions
    : truncateUtf16Safe(instructions, totalMaxChars);
}

/** Compose the shared agent framing and optional identity/profile context for voice. */
export async function resolveRealtimeVoiceAgentContextInstructions(params: {
  agentId: string;
  config: OpenClawConfig;
  sessionKey?: string;
  files?: readonly string[];
  maxChars?: number;
  includeIdentity?: boolean;
  warn?: (message: string) => void;
}): Promise<string> {
  const sections = [REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS];
  if (params.includeIdentity) {
    try {
      // Preserve voice-call's optional rich fields without extending the config schema.
      const identity = asOptionalRecord(resolveAgentIdentity(params.config, params.agentId));
      const fields = [
        ["Name", identity?.name],
        ["Emoji", identity?.emoji],
        ["Vibe", identity?.vibe],
        ["Theme", identity?.theme],
        ["Creature/persona", identity?.creature],
      ] as const;
      const lines = fields.flatMap(([label, value]) => {
        const text = normalizeOptionalString(value);
        return text ? [`- ${label}: ${text}`] : [];
      });
      if (lines.length > 0) {
        sections.push(`Configured identity:\n${lines.join("\n")}`);
      }
    } catch (error) {
      params.warn?.(`realtime configured identity unavailable: ${String(error)}`);
    }
  }
  try {
    const profile = await resolveRealtimeBootstrapContextInstructions(params);
    if (profile) {
      sections.push(profile);
    }
  } catch (error) {
    params.warn?.(`realtime bootstrap context unavailable: ${String(error)}`);
  }
  return sections.join("\n\n");
}
