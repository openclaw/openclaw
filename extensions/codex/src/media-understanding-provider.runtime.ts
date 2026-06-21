/** Runtime implementation for bounded Codex media-understanding turns. */
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import type {
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
  StructuredExtractionRequest,
  StructuredExtractionResult,
} from "openclaw/plugin-sdk/media-understanding";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { CodexMediaUnderstandingProviderOptions } from "../media-understanding-provider.js";
import {
  CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  runCodexTurnStartWithLease,
  settleCodexAppServerClientLease,
  validateCodexThreadCreationResponse,
} from "./app-server/attempt-client-cleanup.js";
import { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-bridge.js";
import type { CodexAppServerClient } from "./app-server/client.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { listAllCodexAppServerModelsWithClient } from "./app-server/models.js";
import {
  assertCodexThreadStartResponse,
  assertCodexTurnStartResponse,
} from "./app-server/protocol-validators.js";
import type {
  CodexThreadStartParams,
  CodexTurnStartParams,
  CodexUserInput,
  JsonValue,
} from "./app-server/protocol.js";
import { buildCodexRuntimeThreadConfig } from "./app-server/runtime-thread-config.js";
import {
  createIsolatedCodexAppServerClient,
  type CodexAppServerClientLease,
  type CodexAppServerClientOptions,
} from "./app-server/shared-client.js";
import { getCodexAppServerTurnRouter } from "./app-server/turn-router.js";
import { createCodexTerminalTextCollector } from "./conversation-turn-collector.js";

const DEFAULT_CODEX_IMAGE_PROMPT = "Describe the image.";
const CODEX_MEDIA_HOME_DIRNAME = "codex-media-home";
const CODEX_MEDIA_THREAD_CONFIG: Record<string, JsonValue> = {
  project_doc_max_bytes: 0,
  web_search: "disabled",
  "tools.experimental_request_user_input.enabled": false,
  "features.hooks": false,
  "features.multi_agent": false,
  "features.apps": false,
  "features.plugins": false,
  "features.image_generation": false,
  "features.skill_mcp_dependency_install": false,
  "features.memories": false,
  "features.goals": false,
};
export async function describeCodexImages(
  req: ImagesDescriptionRequest,
  options: CodexMediaUnderstandingProviderOptions,
): Promise<ImagesDescriptionResult> {
  const model = req.model.trim();
  if (!model) {
    throw new Error("Codex image understanding requires model id.");
  }

  const text = await runBoundedCodexVisionTurn({
    model,
    profile: req.profile,
    timeoutMs: req.timeoutMs,
    agentDir: req.agentDir,
    authStore: req.authStore,
    cfg: req.cfg,
    options,
    taskLabel: "image understanding",
    developerInstructions:
      "You are OpenClaw's bounded image-understanding worker. Describe only the provided image content. Do not call tools, edit files, or ask follow-up questions.",
    input: [
      { type: "text", text: buildCodexImagePrompt(req), text_elements: [] },
      ...req.images.map((image) => ({
        type: "image" as const,
        url: `data:${image.mime ?? "image/png"};base64,${image.buffer.toString("base64")}`,
      })),
    ],
  });
  return { text, model };
}

type BoundedCodexVisionTurnParams = {
  model: string;
  profile?: string;
  timeoutMs: number;
  agentDir?: string;
  authStore?: ImagesDescriptionRequest["authStore"];
  cfg?: ImagesDescriptionRequest["cfg"];
  options: CodexMediaUnderstandingProviderOptions;
  taskLabel: string;
  developerInstructions: string;
  input: CodexUserInput[];
};

async function runBoundedCodexVisionTurn(params: BoundedCodexVisionTurnParams): Promise<string> {
  const appServer = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.options.resolvePluginConfig?.() ?? params.options.pluginConfig,
  });
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 100, 100);
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new Error(`Codex app-server ${params.taskLabel} timed out`)),
    timeoutMs,
  );
  timeout.unref?.();
  const signal = abortController.signal;
  const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.cfg ?? {});
  const mediaHome = path.join(path.resolve(agentDir), CODEX_MEDIA_HOME_DIRNAME);
  const startOptions = {
    ...appServer.start,
    env: {
      ...appServer.start.env,
      CODEX_HOME: mediaHome,
    },
  };
  const authProfileId = resolveCodexAppServerAuthProfileIdForAgent({
    authProfileId: params.profile,
    agentDir,
    ...(params.authStore ? { authProfileStore: params.authStore } : {}),
    config: params.cfg,
  });
  let clientLease: CodexAppServerClientLease | undefined;
  let threadId: string | undefined;
  let abandonClient = false;

  try {
    clientLease = await waitForMediaClientLease(
      (params.options.clientLeaseFactory ?? leaseIsolatedCodexMediaClient)({
        startOptions,
        timeoutMs,
        authProfileId,
        agentDir,
        ...(params.authStore ? { authProfileStore: params.authStore } : {}),
        ...(params.cfg ? { config: params.cfg } : {}),
        abandonSignal: signal,
      }),
      signal,
    );
    const client = clientLease.client;
    await assertCodexModelSupportsInput({
      client,
      model: params.model,
      timeoutMs,
      signal,
    });
    const thread = await validateCodexThreadCreationResponse(
      clientLease,
      await client.request<unknown>(
        "thread/start",
        {
          model: params.model,
          modelProvider: "openai",
          cwd: mediaHome,
          approvalPolicy: "never",
          sandbox: "read-only",
          serviceName: "OpenClaw",
          personality: "none",
          developerInstructions: params.developerInstructions,
          // A distinct empty Codex home plus explicit feature floors keeps this
          // isolated worker free of workspace, plugin, MCP, and side-effecting tools.
          config: buildCodexRuntimeThreadConfig(CODEX_MEDIA_THREAD_CONFIG, {
            nativeCodeModeEnabled: false,
          }),
          environments: [],
          ephemeral: true,
        } satisfies CodexThreadStartParams,
        { timeoutMs, signal },
      ),
      assertCodexThreadStartResponse,
    );
    const activeThreadId = thread.thread.id;
    threadId = activeThreadId;
    const collector = createCodexTerminalTextCollector(activeThreadId, {
      taskLabel: params.taskLabel,
      combineAssistantMessages: true,
    });
    const route = getCodexAppServerTurnRouter(client).reserveThread({
      threadId: activeThreadId,
      onNotification: collector.handleNotification,
    });
    let acceptedTurnId: string | undefined;
    try {
      route.armTurn();
      const turn = await runCodexTurnStartWithLease(clientLease, async () =>
        assertCodexTurnStartResponse(
          await client.request<unknown>(
            "turn/start",
            {
              threadId: activeThreadId,
              input: params.input,
              effort: "low",
            } satisfies CodexTurnStartParams,
            { timeoutMs, signal },
          ),
        ),
      );
      acceptedTurnId = turn.turn.id;
      collector.bindTurn(acceptedTurnId, turn.turn);
      await route.bindTurn(acceptedTurnId);
      const { replyText } = await collector.wait({
        timeoutMs,
        signal: AbortSignal.any([signal, route.signal]),
      });
      const text = replyText.trim();
      if (!text) {
        throw new Error(`Codex app-server ${params.taskLabel} turn returned no text.`);
      }
      return text;
    } catch (error) {
      if (acceptedTurnId && !collector.completed) {
        try {
          // Codex confirms turn/interrupt only after execution stops. An
          // unconfirmed accepted media turn makes this client unsafe to pool.
          await client.request(
            "turn/interrupt",
            { threadId: activeThreadId, turnId: acceptedTurnId },
            { timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS },
          );
        } catch (interruptError) {
          abandonClient = true;
          embeddedAgentLog.warn(
            "codex media turn interruption was not confirmed; retiring client",
            { threadId: activeThreadId, turnId: acceptedTurnId, error: interruptError },
          );
        }
      } else {
        await route.cancelTurn();
      }
      throw error;
    } finally {
      route.release();
    }
  } catch (error) {
    abandonClient ||= signal.aborted;
    throw error;
  } finally {
    clearTimeout(timeout);
    if (clientLease) {
      await settleCodexAppServerClientLease(clientLease, {
        threadId,
        timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        abandon: abandonClient,
      });
    }
  }
}

async function leaseIsolatedCodexMediaClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClientLease> {
  const client = await createIsolatedCodexAppServerClient(options);
  let settled = false;
  return {
    client,
    release: () => {
      if (settled) {
        return;
      }
      settled = true;
      // Ephemeral Codex threads cannot be deleted, so their process is the
      // lifecycle boundary that releases image-bearing history immediately.
      client.close();
    },
    abandon: async () => {
      if (settled) {
        return;
      }
      settled = true;
      await client.closeAndWait();
    },
  };
}

export async function extractCodexStructured(
  req: StructuredExtractionRequest,
  options: CodexMediaUnderstandingProviderOptions,
): Promise<StructuredExtractionResult> {
  const model = req.model.trim();
  if (!model) {
    throw new Error("Codex structured extraction requires model id.");
  }
  const instructions = req.instructions.trim();
  if (!instructions) {
    throw new Error("Codex structured extraction requires instructions.");
  }
  if (req.input.length === 0) {
    throw new Error("Codex structured extraction requires at least one input.");
  }
  if (!req.input.some((entry) => entry.type === "image")) {
    throw new Error("Codex structured extraction requires at least one image input.");
  }

  const text = await runBoundedCodexVisionTurn({
    model,
    profile: req.profile,
    timeoutMs: req.timeoutMs,
    agentDir: req.agentDir,
    authStore: req.authStore,
    cfg: req.cfg,
    options,
    taskLabel: "structured extraction",
    developerInstructions:
      "You are OpenClaw's bounded structured-extraction worker. Return only the requested extraction. Do not call tools, edit files, ask follow-up questions, or include secrets.",
    input: buildCodexStructuredInput(req),
  });
  return normalizeStructuredExtractionResult({ text, model, provider: req.provider, req });
}

async function assertCodexModelSupportsInput(params: {
  client: CodexAppServerClient;
  model: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<void> {
  const listed = (
    await listAllCodexAppServerModelsWithClient(params.client, {
      limit: 100,
      includeHidden: true,
      timeoutMs: Math.min(params.timeoutMs, 5_000),
      signal: params.signal,
    })
  ).models;
  const match = listed.find((entry) => entry.model === params.model || entry.id === params.model);
  if (!match) {
    throw new Error(`Codex app-server model not found: ${params.model}`);
  }
  if (!match.inputModalities.includes("image")) {
    throw new Error(`Codex app-server model does not support images: ${params.model}`);
  }
  if (!match.inputModalities.includes("text")) {
    throw new Error(`Codex app-server model does not support text: ${params.model}`);
  }
}

async function waitForMediaClientLease(
  operation: Promise<CodexAppServerClientLease>,
  signal: AbortSignal,
): Promise<CodexAppServerClientLease> {
  if (signal.aborted) {
    void operation.then(retireLateMediaClientLease, () => undefined);
    throw mediaClientError(signal.reason, "Codex media client acquisition aborted");
  }
  return await new Promise<CodexAppServerClientLease>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(mediaClientError(signal.reason, "Codex media client acquisition aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (lease) => {
        if (settled) {
          void retireLateMediaClientLease(lease);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(lease);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(mediaClientError(error, "Codex media client acquisition failed"));
      },
    );
  });
}

function mediaClientError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

async function retireLateMediaClientLease(lease: CodexAppServerClientLease): Promise<void> {
  try {
    await lease.abandon();
  } catch (error) {
    embeddedAgentLog.warn("codex media client resolved after its deadline and could not retire", {
      error,
    });
  }
}

function buildCodexImagePrompt(req: ImagesDescriptionRequest): string {
  const prompt = req.prompt?.trim() || DEFAULT_CODEX_IMAGE_PROMPT;
  if (req.images.length <= 1) {
    return prompt;
  }
  return `${prompt}\n\nAnalyze all ${req.images.length} images together.`;
}

function buildCodexStructuredInput(req: StructuredExtractionRequest): CodexUserInput[] {
  return [
    { type: "text", text: buildStructuredExtractionPrompt(req), text_elements: [] },
    ...req.input.map((entry) => {
      if (entry.type === "text") {
        return { type: "text" as const, text: entry.text, text_elements: [] };
      }
      return {
        type: "image" as const,
        url: `data:${entry.mime ?? "image/png"};base64,${entry.buffer.toString("base64")}`,
      };
    }),
  ];
}

function buildStructuredExtractionPrompt(req: StructuredExtractionRequest): string {
  return [
    req.instructions.trim(),
    req.schemaName ? `Schema name: ${req.schemaName}` : undefined,
    req.jsonSchema ? `JSON schema:\n${JSON.stringify(req.jsonSchema)}` : undefined,
    req.jsonMode === false
      ? "Return the extraction as concise text."
      : "Return valid JSON only. Do not wrap the JSON in Markdown fences.",
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStructuredExtractionResult(params: {
  text: string;
  model: string;
  provider: string;
  req: StructuredExtractionRequest;
}): StructuredExtractionResult {
  const result: StructuredExtractionResult = {
    text: params.text,
    model: params.model,
    provider: params.provider,
    contentType: params.req.jsonMode === false ? "text" : "json",
  };
  if (params.req.jsonMode !== false) {
    try {
      result.parsed = JSON.parse(params.text);
    } catch {
      throw new Error("Codex structured extraction returned invalid JSON.");
    }
    if (isJsonSchemaObject(params.req.jsonSchema)) {
      const validation = validateJsonSchemaValue({
        schema: params.req.jsonSchema,
        cacheKey: "codex.media-understanding.extractStructured",
        value: result.parsed,
        cache: false,
      });
      if (!validation.ok) {
        const message = validation.errors.map((error) => error.text).join("; ") || "invalid";
        throw new Error(`Codex structured extraction JSON did not match schema: ${message}`);
      }
      result.parsed = validation.value;
    }
  }
  return result;
}
