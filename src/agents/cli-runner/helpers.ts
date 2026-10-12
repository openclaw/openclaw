import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { fileStore } from "@openclaw/fs-safe/store";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { extensionForMime } from "@openclaw/media-core/mime";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { resolveRuntimeOsLabel } from "../../infra/os-summary.js";
import { privateFileStore } from "../../infra/private-file-store.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { ImageContent } from "../../llm/types.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../plugins/command-registry-state.js";
import type { BootstrapMode } from "../bootstrap-mode.js";
import { formatCliImageTurnContext } from "../cli-image-turn-correlation.js";
import type { EmbeddedContextFile } from "../embedded-agent-helpers/context-file.js";
import {
  detectAndLoadPromptImages,
  detectImageReferences,
} from "../embedded-agent-runner/run/images.js";
import type { MediaImageLayout } from "../embedded-agent-runner/run/prompt-image-metadata.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import type { AgentTool } from "../runtime/index.js";
import { detectRuntimeShell } from "../shell-utils.js";
import { buildConfiguredAgentSystemPrompt } from "../system-prompt-config.js";
import { buildSystemPromptParams } from "../system-prompt-params.js";
import type { SilentReplyPromptMode } from "../system-prompt.types.js";
import { cliBackendLog } from "./log.js";
import { formatTomlConfigOverride } from "./toml-inline.js";

const CLI_RUN_QUEUE = new KeyedAsyncQueue();
const CLI_IMAGE_SWEEP_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const sweptCliImageRoots = new Set<string>();

export function isClaudeCliBackendId(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId) === "claude-cli";
}

export function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  return CLI_RUN_QUEUE.enqueue(key, task);
}

export function resolveCliRunQueueKey(params: {
  backendId: string;
  liveSession?: CliBackendConfig["liveSession"];
  serialize?: boolean;
  runId: string;
  workspaceDir: string;
  cliSessionId?: string;
  ownerKey?: string;
}): string {
  const requiresLiveSessionSerialization = params.liveSession !== undefined;
  if (params.serialize === false && !requiresLiveSessionSerialization) {
    return `${params.backendId}:${params.runId}`;
  }
  const ownerKey = params.ownerKey?.trim();
  if (requiresLiveSessionSerialization && ownerKey) {
    return `${params.backendId}:owner:${ownerKey}`;
  }
  if (isClaudeCliBackendId(params.backendId)) {
    const sessionId = params.cliSessionId?.trim();
    if (sessionId) {
      return `${params.backendId}:session:${sessionId}`;
    }
    if (ownerKey) {
      return `${params.backendId}:owner:${ownerKey}`;
    }
    const workspaceDir = params.workspaceDir.trim();
    if (workspaceDir) {
      return `${params.backendId}:workspace:${workspaceDir}`;
    }
  }
  return params.backendId;
}

export function buildCliAgentSystemPrompt(params: {
  preparedTtsPreferences?: import("../../tts/tts-preferences.js").PreparedTtsPreferences;
  requesterProfileId?: string;
  workspaceDir: string;
  cwd?: string;
  config?: OpenClawConfig;
  preparedModelRuntime?: Parameters<
    typeof buildConfiguredAgentSystemPrompt
  >[0]["preparedModelRuntime"];
  preparedGitCoauthorPrompt?: string;
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  requireExplicitMessageTarget?: boolean;
  silentReplyPromptMode?: SilentReplyPromptMode;
  runtimeChannel?: string;
  runtimeChatType?: ChatType;
  runtimeCapabilities?: string[];
  ownerNumbers?: string[];
  docsPath?: string;
  sourcePath?: string;
  tools: AgentTool[];
  /** Prefix the backend adds when exposing `tools` to the model; see `resolveOpenClawMcpToolNamePrefix`. */
  toolNamePrefix?: string;
  contextFiles?: EmbeddedContextFile[];
  bootstrapMode?: BootstrapMode;
  bootstrapTruncationNotice?: string;
  skillsPrompt?: string;
  modelDisplay: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
}) {
  const runtimeCwd = params.cwd?.trim() || params.workspaceDir;
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: params.config ?? {},
    agentId: params.agentId,
  });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const messageTool = params.tools.find((tool) => tool.name.trim().toLowerCase() === "message");
  const { runtimeInfo } = buildSystemPromptParams({
    config: params.config,
    agentId: params.agentId,
    workspaceDir: runtimeCwd,
    cwd: runtimeCwd,
    preparedGitCoauthorPrompt: params.preparedGitCoauthorPrompt,
    requesterProfileId: params.requesterProfileId,
    runtime: {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      host: "openclaw",
      os: resolveRuntimeOsLabel(),
      arch: os.arch(),
      node: process.version,
      model: params.modelDisplay,
      defaultModel: defaultModelLabel,
      shell: detectRuntimeShell(),
      channel: params.runtimeChannel,
      chatType: params.runtimeChatType,
      capabilities: params.runtimeCapabilities,
    },
  });
  return buildConfiguredAgentSystemPrompt({
    config: params.config,
    preparedModelRuntime: params.preparedModelRuntime,
    preparedTtsPreferences: params.preparedTtsPreferences,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    runtimeCwd,
    extraSystemPrompt: params.extraSystemPrompt,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    silentReplyPromptMode: params.silentReplyPromptMode,
    ownerNumbers: params.ownerNumbers,
    reasoningTagHint: false,
    docsPath: params.docsPath,
    sourcePath: params.sourcePath,
    acpEnabled: isAcpRuntimeSpawnAvailable({ config: params.config }),
    promptSurface: "cli_backend",
    nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
      surface: "cli_backend",
    }),
    runtimeInfo,
    toolNames: params.tools.map((tool) => tool.name),
    toolNamePrefix: params.toolNamePrefix,
    messageTool: messageTool && {
      ...messageTool,
      name: `${params.toolNamePrefix ?? ""}${messageTool.name}`,
    },
    skillsPrompt: params.skillsPrompt,
    contextFiles: params.contextFiles,
    bootstrapMode: params.bootstrapMode,
    bootstrapTruncationNotice: params.bootstrapTruncationNotice,
  });
}

export function normalizeCliModel(modelId: string, backend: CliBackendConfig): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  return (
    backend.modelAliases?.[trimmed] || backend.modelAliases?.[trimmed.toLowerCase()] || trimmed
  );
}

export function resolveSystemPromptUsage(params: {
  backend: CliBackendConfig;
  isNewSession: boolean;
  systemPrompt?: string;
}): string | null {
  const systemPrompt = params.systemPrompt?.trim();
  const when = params.backend.systemPromptWhen ?? "first";
  if (
    !systemPrompt ||
    when === "never" ||
    (when === "first" && !params.isNewSession) ||
    (!params.backend.systemPromptArg?.trim() &&
      !params.backend.systemPromptFileArg?.trim() &&
      !params.backend.systemPromptFileConfigKey?.trim())
  ) {
    return null;
  }
  return systemPrompt;
}

export function resolveSessionIdToSend(params: {
  backend: CliBackendConfig;
  cliSessionId?: string;
}): { sessionId?: string; isNew: boolean } {
  const mode = params.backend.sessionMode ?? "always";
  const existing = params.cliSessionId?.trim();
  const sessionId =
    mode === "none" ? undefined : mode === "existing" || existing ? existing : crypto.randomUUID();
  return { sessionId, isNew: !existing };
}

export function resolvePromptInput(params: { backend: CliBackendConfig; prompt: string }): {
  argsPrompt?: string;
  stdin?: string;
} {
  if (
    params.backend.input === "stdin" ||
    (params.backend.maxPromptArgChars && params.prompt.length > params.backend.maxPromptArgChars)
  ) {
    return { stdin: params.prompt };
  }
  return { argsPrompt: params.prompt };
}

function resolveCliImageFileName(image: ImageContent): string {
  const ext = extensionForMime(image.mimeType) ?? ".bin";
  return `${sha256Hex(`${image.mimeType}\0${image.data}`)}${ext}`;
}

async function sweepCliImageRoot(imageRoot: string): Promise<void> {
  if (sweptCliImageRoots.has(imageRoot)) {
    return;
  }
  sweptCliImageRoots.add(imageRoot);
  try {
    await fileStore({ rootDir: imageRoot }).pruneExpired({ ttlMs: CLI_IMAGE_SWEEP_TTL_MS });
  } catch (error) {
    cliBackendLog.debug(`cli image cache sweep failed: ${String(error)}`);
  }
}

function appendImagePathsToPrompt(prompt: string, paths: string[], prefix = ""): string {
  if (!paths.length) {
    return prompt;
  }
  const trimmed = prompt.trimEnd();
  const separator = trimmed ? "\n\n" : "";
  return `${trimmed}${separator}${paths.map((entry) => `${prefix}${entry}`).join("\n")}`;
}

async function writeCliImages(params: {
  backend: CliBackendConfig;
  workspaceDir: string;
  images: ImageContent[];
}): Promise<string[]> {
  const imageRoot =
    params.backend.imagePathScope === "workspace"
      ? path.join(params.workspaceDir, ".openclaw-cli-images")
      : path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images");
  await fs.mkdir(imageRoot, { recursive: true, mode: 0o700 });
  await sweepCliImageRoot(imageRoot);
  const store = privateFileStore(imageRoot);
  const paths: string[] = [];
  for (const image of params.images) {
    const fileName = resolveCliImageFileName(image);
    const buffer = Buffer.from(image.data, "base64");
    await store.writeText(fileName, buffer);
    paths.push(store.path(fileName));
  }
  // Keep content-addressed image paths stable across Claude CLI runs so prompt
  // text and argv don't churn on every turn with fresh temp-dir suffixes.
  return paths;
}

export async function writeCliSystemPromptFile(params: {
  backend: CliBackendConfig;
  systemPrompt: string;
}): Promise<{ filePath?: string; cleanup: () => Promise<void> }> {
  if (
    !params.backend.systemPromptFileArg?.trim() &&
    !params.backend.systemPromptFileConfigKey?.trim()
  ) {
    return { cleanup: async () => {} };
  }
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-cli-system-prompt-",
  });
  const filePath = await workspace.write(
    "system-prompt.md",
    stripSystemPromptCacheBoundary(params.systemPrompt),
  );
  return {
    filePath,
    cleanup: () => workspace.cleanup().then(() => undefined),
  };
}

export async function prepareCliPromptImagePayload(params: {
  backend: CliBackendConfig;
  prompt: string;
  imagePrompt?: string;
  workspaceDir: string;
  localRoots?: readonly string[];
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  mediaImageLayout?: MediaImageLayout;
  media?: MediaFact[];
  imageTurnKey?: string;
}): Promise<{
  prompt: string;
  imagePaths?: string[];
}> {
  let prompt = params.prompt;
  const imagePrompt = params.imagePrompt ?? prompt;
  const needsHydration =
    params.imagePrompt !== undefined ||
    Boolean(params.media?.length) ||
    Boolean(params.mediaImageLayout) ||
    (!params.images?.length && detectImageReferences(imagePrompt).length > 0);
  const imageResult = needsHydration
    ? await detectAndLoadPromptImages({
        prompt: imagePrompt,
        media: params.media,
        workspaceDir: params.workspaceDir,
        model: { input: ["text", "image"] },
        existingImages: params.images,
        imageOrder: params.imageOrder,
        mediaImageLayout: params.mediaImageLayout,
        maxBytes: MAX_IMAGE_BYTES,
        localRoots: params.localRoots,
      })
    : undefined;
  if (imageResult?.failedMediaCount) {
    throw new Error(
      `failed to hydrate ${imageResult.failedMediaCount} structured image attachment(s) for CLI input`,
    );
  }
  const resolvedImages = imageResult?.images ?? params.images ?? [];
  if (resolvedImages.length === 0) {
    return { prompt };
  }
  const imagePaths = await writeCliImages({
    backend: params.backend,
    workspaceDir: params.workspaceDir,
    images: resolvedImages,
  });
  if (
    !params.backend.imageArg ||
    params.backend.input === "stdin" ||
    params.backend.imageArg === "@"
  ) {
    if (params.imageTurnKey) {
      prompt = `${prompt.trimEnd()}\n\n${formatCliImageTurnContext(params.imageTurnKey)}`;
    }
    prompt = appendImagePathsToPrompt(
      prompt,
      imagePaths,
      params.backend.imageArg === "@" ? "@" : "",
    );
  }
  return {
    prompt,
    imagePaths,
  };
}

export function buildCliArgs(params: {
  backend: CliBackendConfig;
  baseArgs: string[];
  modelId: string;
  sessionId?: string;
  systemPrompt?: string | null;
  systemPromptFilePath?: string;
  imagePaths?: string[];
  promptArg?: string;
  useResume: boolean;
  forkResume?: boolean;
  resumeAt?: string;
  sendSystemPromptOnResume?: boolean;
}): string[] {
  const args: string[] = [...params.baseArgs];
  const shouldSendSystemPrompt =
    !params.useResume ||
    params.backend.systemPromptWhen === "always" ||
    params.sendSystemPromptOnResume;
  if (params.backend.modelArg && params.modelId) {
    args.push(params.backend.modelArg, params.modelId);
  }
  if (shouldSendSystemPrompt && params.systemPrompt) {
    if (params.systemPromptFilePath && params.backend.systemPromptFileArg) {
      args.push(params.backend.systemPromptFileArg, params.systemPromptFilePath);
    } else if (params.systemPromptFilePath && params.backend.systemPromptFileConfigKey) {
      args.push(
        params.backend.systemPromptFileConfigArg ?? "-c",
        formatTomlConfigOverride(
          params.backend.systemPromptFileConfigKey,
          params.systemPromptFilePath,
        ),
      );
    } else if (params.backend.systemPromptArg) {
      args.push(
        params.backend.systemPromptArg,
        stripSystemPromptCacheBoundary(params.systemPrompt),
      );
    }
  }
  if (!params.useResume && params.sessionId) {
    for (const entry of params.backend.sessionArgs ?? []) {
      args.push(entry.replaceAll("{sessionId}", params.sessionId));
    }
  }
  if (params.useResume && params.forkResume) {
    if (!params.backend.forkArg) {
      throw new Error("CLI backend does not support forked session resume");
    }
    args.push(params.backend.forkArg);
  }
  if (params.resumeAt) {
    if (!params.useResume || !params.backend.resumeAtArg) {
      throw new Error("CLI backend does not support checkpointed session resume");
    }
    args.push(params.backend.resumeAtArg, params.resumeAt);
  }
  if (params.promptArg !== undefined) {
    let replacedPromptPlaceholder = false;
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "{prompt}") {
        args[i] = params.promptArg;
        replacedPromptPlaceholder = true;
      }
    }
    if (!replacedPromptPlaceholder) {
      args.push(params.promptArg);
    }
  }
  const imageArg = params.backend.imageArg;
  if (params.imagePaths?.length && imageArg && imageArg !== "@") {
    if (params.backend.imageMode === "list") {
      args.push(imageArg, params.imagePaths.join(","));
    } else {
      for (const imagePath of params.imagePaths) {
        args.push(imageArg, imagePath);
      }
    }
  }
  return args;
}
