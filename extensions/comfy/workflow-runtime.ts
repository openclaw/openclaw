import { randomInt } from "node:crypto";
import fs from "node:fs/promises";
import { bufferToBlobPart } from "openclaw/plugin-sdk/blob-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import {
  isProviderApiKeyConfigured,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  readProviderBinaryResponse,
  readProviderJsonResponse,
  redactProviderResponseErrorText,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import {
  normalizeSecretInputString,
  resolveConfiguredSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input-runtime";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/secret-ref-readonly";
import {
  fetchWithSsrFGuard,
  isPrivateOrLoopbackHost,
  mergeSsrFPolicies,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asBoolean,
  isRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveUserPath, sleep } from "openclaw/plugin-sdk/text-utility-runtime";

const DEFAULT_COMFY_LOCAL_BASE_URL = "http://127.0.0.1:8188";
const DEFAULT_COMFY_CLOUD_BASE_URL = "https://cloud.comfy.org";
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
// randomInt requires a range below 2**48; these seeds also round-trip through JSON exactly.
const RANDOM_SEED_EXCLUSIVE_MAX = 2 ** 48 - 1;

export const DEFAULT_COMFY_MODEL = "workflow";

type ComfyMode = "local" | "cloud";
type ComfyCapability = "image" | "music" | "video";
type ComfyOutputKind = "audio" | "gifs" | "images" | "videos";
type ComfyWorkflow = Record<string, unknown>;
type ComfyProviderConfig = Record<string, unknown>;
type ComfyFetchGuardParams = Parameters<typeof fetchWithSsrFGuard>[0];
type ComfyDispatcherPolicy = ComfyFetchGuardParams["dispatcherPolicy"];
type ComfyPromptResponse = {
  prompt_id?: string;
};
type ComfyOutputFile = {
  filename?: string;
  name?: string;
  subfolder?: string;
  type?: string;
};
type ComfyHistoryOutputEntry = Partial<Record<ComfyOutputKind, ComfyOutputFile[]>>;
type ComfyHistoryEntry = {
  outputs?: Record<string, ComfyHistoryOutputEntry>;
};
type ComfyUploadResponse = {
  name?: string;
  filename?: string;
};
type ComfyStatusResponse = {
  status?: string;
  message?: string;
  error?: string;
};
type ComfyApiKeyResolution =
  | {
      status: "available";
      apiKey: string;
    }
  | {
      status: "missing";
    }
  | {
      status: "configured_unavailable";
    };

type ComfySourceImage = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
};

type ComfyGeneratedAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  metadata: { nodeId: string; promptId: string };
};

type ComfyWorkflowResult = {
  assets: ComfyGeneratedAsset[];
  model: string;
  metadata: { promptId: string; outputNodeIds: string[] };
};

function readConfigInteger(config: ComfyProviderConfig, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function getComfyConfig(cfg?: OpenClawConfig): { config: ComfyProviderConfig; path: string } {
  const pluginConfig = cfg?.plugins?.entries?.comfy?.config;
  if (isRecord(pluginConfig)) {
    return { config: pluginConfig, path: "plugins.entries.comfy.config" };
  }
  const legacyConfig = cfg?.models?.providers?.comfy;
  return { config: isRecord(legacyConfig) ? legacyConfig : {}, path: "models.providers.comfy" };
}

function getComfyCapabilityConfig(
  config: ComfyProviderConfig,
  capability: ComfyCapability,
): ComfyProviderConfig {
  const shared = { ...config };
  delete shared.image;
  delete shared.video;
  delete shared.music;
  const nested = config[capability];
  return isRecord(nested) ? { ...shared, ...nested } : shared;
}

function resolveComfyMode(config: ComfyProviderConfig): ComfyMode {
  return normalizeOptionalString(config.mode) === "cloud" ? "cloud" : "local";
}

function resolveComfyApiKey(
  config: ComfyProviderConfig,
  cfg?: OpenClawConfig,
): ComfyApiKeyResolution {
  const resolved = resolveSecretInputString({
    value: config.apiKey,
    path: "plugins.entries.comfy.config.apiKey",
    defaults: cfg?.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    const apiKey = normalizeSecretInputString(resolved.value);
    return apiKey
      ? {
          status: "available",
          apiKey,
        }
      : { status: "missing" };
  }
  if (resolved.status === "configured_unavailable") {
    if (resolved.ref.source !== "env") {
      return { status: "configured_unavailable" };
    }
    const envVarName = resolved.ref.id.trim();
    if (
      !canResolveEnvSecretRefInReadOnlyPath({
        cfg,
        provider: resolved.ref.provider,
        id: envVarName,
      })
    ) {
      return { status: "configured_unavailable" };
    }
    const apiKey = normalizeSecretInputString(process.env[envVarName]);
    return apiKey
      ? {
          status: "available",
          apiKey,
        }
      : { status: "configured_unavailable" };
  }
  return { status: "missing" };
}

async function loadComfyWorkflow(config: ComfyProviderConfig): Promise<ComfyWorkflow> {
  const workflow = config.workflow;
  if (isRecord(workflow)) {
    return structuredClone(workflow);
  }
  const workflowPath = normalizeOptionalString(config.workflowPath);
  if (!workflowPath) {
    throw new Error(
      "plugins.entries.comfy.config.<capability>.workflow or workflowPath is required",
    );
  }

  const resolvedPath = resolveUserPath(workflowPath);
  const raw = await fs.readFile(resolvedPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Comfy workflow at ${resolvedPath} must be a JSON object`);
  }
  return parsed;
}

function setWorkflowInput(
  workflow: ComfyWorkflow,
  nodeId: string,
  inputName: string,
  value: unknown,
): void {
  const node = workflow[nodeId];
  if (!isRecord(node)) {
    throw new Error(`Comfy workflow missing node "${nodeId}"`);
  }
  const inputs = node.inputs;
  if (!isRecord(inputs)) {
    throw new Error(`Comfy workflow node "${nodeId}" is missing an inputs object`);
  }
  inputs[inputName] = value;
}

async function resolveComfyHeadersConfig(
  value: unknown,
  cfg: OpenClawConfig,
  configPath: string,
): Promise<Headers> {
  const headers = new Headers();
  if (!isRecord(value)) {
    return headers;
  }
  for (const [name, headerValue] of Object.entries(value)) {
    const path = `${configPath}.headers[${JSON.stringify(name)}]`;
    const resolved = await resolveConfiguredSecretInputString({
      config: cfg,
      env: process.env,
      value: headerValue,
      path,
      unresolvedReasonStyle: "detailed",
    });
    if (resolved.unresolvedRefReason) {
      throw new Error(`${path} references an unavailable secret: ${resolved.unresolvedRefReason}`);
    }
    if (resolved.value) {
      headers.set(name, resolved.value);
    }
  }
  return headers;
}

function resolveComfyNetworkPolicy(params: {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  explicitAllowPrivateNetwork: boolean;
  mode: ComfyMode;
}): SsrFPolicy | undefined {
  const parsed = URL.parse(params.baseUrl);
  if (!parsed) {
    return undefined;
  }

  const hostname = normalizeOptionalLowercaseString(parsed.hostname) ?? "";
  if (!hostname) {
    return undefined;
  }
  const localHostnamePolicy: SsrFPolicy | undefined =
    params.mode === "local" ? { hostnameAllowlist: [hostname] } : undefined;
  if (!params.allowPrivateNetwork) {
    return localHostnamePolicy;
  }
  // Local mode auto-trusts loopback/IP targets and Compose-style single-label
  // service names; public-looking FQDNs require the operator's explicit
  // allowPrivateNetwork opt-in.
  if (!params.explicitAllowPrivateNetwork && params.mode !== "local") {
    return undefined;
  }
  if (
    !params.explicitAllowPrivateNetwork &&
    params.mode === "local" &&
    !isPrivateOrLoopbackHost(hostname) &&
    !isSingleLabelServiceHostname(hostname)
  ) {
    return localHostnamePolicy;
  }

  const originPolicy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(params.baseUrl);
  if (!originPolicy) {
    return localHostnamePolicy;
  }

  return params.mode === "local"
    ? mergeSsrFPolicies(originPolicy, localHostnamePolicy)
    : originPolicy;
}

function isSingleLabelServiceHostname(hostname: string): boolean {
  return /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/u.test(hostname);
}

async function readJsonResponse<T>(params: {
  url: string;
  init?: RequestInit;
  timeoutMs?: number;
  policy?: SsrFPolicy;
  dispatcherPolicy?: ComfyDispatcherPolicy;
  auditContext: string;
  errorPrefix: string;
}): Promise<T> {
  const { errorPrefix, ...request } = params;
  const { response, release } = await fetchWithSsrFGuard(request);
  try {
    const requestHeaders = params.init?.headers;
    await assertOkOrThrowHttpError(response, errorPrefix, { requestHeaders });
    return await readProviderJsonResponse<T>(response, errorPrefix, { requestHeaders });
  } finally {
    await release();
  }
}

async function uploadInputImage(params: {
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  policy?: SsrFPolicy;
  dispatcherPolicy?: ComfyDispatcherPolicy;
  image: ComfySourceImage;
  mode: ComfyMode;
  capability: ComfyCapability;
}): Promise<string> {
  const form = new FormData();
  form.set(
    "image",
    new Blob([bufferToBlobPart(params.image.buffer)], { type: params.image.mimeType }),
    normalizeOptionalString(params.image.fileName) ||
      `input.${extensionForMime(params.image.mimeType)?.slice(1) || "bin"}`,
  );
  form.set("type", "input");
  form.set("overwrite", "true");

  const headers = new Headers(params.headers);
  headers.delete("Content-Type");

  const payload = await readJsonResponse<ComfyUploadResponse>({
    url: `${params.baseUrl}${params.mode === "cloud" ? "/api/upload/image" : "/upload/image"}`,
    init: {
      method: "POST",
      headers,
      body: form,
    },
    timeoutMs: params.timeoutMs,
    policy: params.policy,
    dispatcherPolicy: params.dispatcherPolicy,
    auditContext: `comfy-${params.capability}-upload`,
    errorPrefix: "Comfy image upload failed",
  });

  const uploadedName =
    normalizeOptionalString(payload.filename) || normalizeOptionalString(payload.name);
  if (!uploadedName) {
    throw new Error("Comfy image upload response missing filename");
  }
  return uploadedName;
}

function extractHistoryEntry(history: unknown, promptId: string): ComfyHistoryEntry | null {
  if (!isRecord(history)) {
    return null;
  }
  const directOutputs = history.outputs;
  if (isRecord(directOutputs)) {
    return history as ComfyHistoryEntry;
  }
  const nested = history[promptId];
  if (isRecord(nested)) {
    return nested as ComfyHistoryEntry;
  }
  return null;
}

async function waitForComfyHistory(params: {
  baseUrl: string;
  promptId: string;
  headers: Headers;
  timeoutMs: number;
  pollIntervalMs: number;
  policy?: SsrFPolicy;
  dispatcherPolicy?: ComfyDispatcherPolicy;
  mode: ComfyMode;
}): Promise<unknown> {
  const deadline = Date.now() + params.timeoutMs;
  const read = <T>(path: string, kind: "history" | "status", timeoutMs: number) =>
    readJsonResponse<T>({
      url: `${params.baseUrl}${path}`,
      init: {
        method: "GET",
        headers: params.headers,
      },
      timeoutMs,
      policy: params.policy,
      dispatcherPolicy: params.dispatcherPolicy,
      auditContext: `comfy-${kind}`,
      errorPrefix: `Comfy ${kind} lookup failed`,
    });

  for (;;) {
    const requestTimeoutMs = resolveComfyRemainingMs(deadline, params.timeoutMs);
    if (params.mode === "cloud") {
      const status = await read<ComfyStatusResponse>(
        `/api/job/${params.promptId}/status`,
        "status",
        requestTimeoutMs,
      );
      if (status.status === "completed") {
        // Cloud history gets a fresh request budget after the job completes.
        return await read<unknown>(
          `/api/history_v2/${params.promptId}`,
          "history",
          params.timeoutMs,
        );
      }
      if (status.status === "failed" || status.status === "cancelled") {
        const detail = redactProviderResponseErrorText(
          status.error ?? status.message ?? params.promptId,
          params.headers,
        );
        throw new Error(`Comfy workflow ${status.status}: ${detail}`);
      }
    } else {
      const history = await read<unknown>(
        `/history/${params.promptId}`,
        "history",
        requestTimeoutMs,
      );
      const entry = extractHistoryEntry(history, params.promptId);
      if (entry?.outputs && Object.keys(entry.outputs).length > 0) {
        return entry;
      }
    }
    const pollDelayMs = resolveComfyRemainingMs(deadline, params.timeoutMs, params.pollIntervalMs);
    await sleep(pollDelayMs);
  }
}

function resolveComfyRemainingMs(
  deadline: number,
  timeoutMs: number,
  defaultTimeoutMs = timeoutMs,
) {
  const defaultMs = resolvePositiveTimerTimeoutMs(defaultTimeoutMs, 1);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`Comfy workflow did not finish within ${Math.ceil(timeoutMs / 1000)}s`);
  }
  return Math.max(1, Math.min(defaultMs, remainingMs));
}

function collectOutputFiles(params: {
  history: ComfyHistoryEntry;
  outputNodeId?: string;
  outputKinds: readonly ComfyOutputKind[];
  capability: ComfyCapability;
}): Array<{ nodeId: string; file: ComfyOutputFile }> {
  const outputs = params.history.outputs;
  if (!outputs) {
    return [];
  }

  const nodeIds = params.outputNodeId ? [params.outputNodeId] : Object.keys(outputs);
  const files: Array<{ nodeId: string; file: ComfyOutputFile }> = [];
  for (const nodeId of nodeIds) {
    const entry = outputs[nodeId];
    if (!entry) {
      continue;
    }
    for (const kind of params.outputKinds) {
      const bucket = entry[kind];
      if (!Array.isArray(bucket)) {
        continue;
      }
      for (const file of bucket) {
        if (params.capability === "video" && kind === "images") {
          // Comfy SaveVideo shares the images bucket with real image outputs.
          // Filter before download so mixed workflows cannot return images as videos.
          const fileName =
            normalizeOptionalString(file.filename) || normalizeOptionalString(file.name);
          if (!fileName || !/\.(?:mp4|webm)$/i.test(fileName)) {
            continue;
          }
        }
        files.push({ nodeId, file });
      }
    }
  }
  return files;
}

async function downloadOutputFile(params: {
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  policy?: SsrFPolicy;
  dispatcherPolicy?: ComfyDispatcherPolicy;
  file: ComfyOutputFile;
  mode: ComfyMode;
  capability: ComfyCapability;
  maxBytes: number;
}): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  const fileName =
    normalizeOptionalString(params.file.filename) || normalizeOptionalString(params.file.name);
  if (!fileName) {
    throw new Error("Comfy output entry missing filename");
  }

  const query = new URLSearchParams({
    filename: fileName,
    subfolder: normalizeOptionalString(params.file.subfolder) ?? "",
    type: normalizeOptionalString(params.file.type) ?? "output",
  });
  const viewPath = params.mode === "cloud" ? "/api/view" : "/view";
  const auditContext = `comfy-${params.capability}-download`;

  const firstResponse = await fetchWithSsrFGuard({
    url: `${params.baseUrl}${viewPath}?${query.toString()}`,
    init: {
      method: "GET",
      headers: params.headers,
    },
    timeoutMs: params.timeoutMs,
    policy: params.policy,
    dispatcherPolicy: params.dispatcherPolicy,
    auditContext,
  });

  try {
    await assertOkOrThrowHttpError(firstResponse.response, "Comfy output download failed", {
      requestHeaders: params.headers,
    });
    const mimeType =
      normalizeOptionalString(firstResponse.response.headers.get("content-type")) ||
      "application/octet-stream";
    const downloadLabel = `Comfy ${params.capability} output download`;
    const buffer = await readProviderBinaryResponse(
      firstResponse.response,
      downloadLabel,
      params.capability,
      {
        maxBytes: params.maxBytes,
        chunkTimeoutMs: params.timeoutMs,
        onOverflow: ({ maxBytes }) => new Error(`${downloadLabel} exceeds ${maxBytes} bytes`),
        onIdleTimeout: ({ chunkTimeoutMs }) =>
          new Error(`${downloadLabel} stalled after ${chunkTimeoutMs}ms`),
      },
    );
    return { buffer, mimeType, fileName };
  } finally {
    await firstResponse.release();
  }
}

// Only env refs can be checked without I/O. Keep other refs selectable until
// the async request resolver can establish their availability.
function hasUnavailableComfyHeaderSecret(value: unknown, cfg?: OpenClawConfig): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(([name, headerValue]) => {
    const inspected = resolveSecretInputString({
      value: headerValue,
      path: `plugins.entries.comfy.config.headers.${name}`,
      defaults: cfg?.secrets?.defaults,
      mode: "inspect",
    });
    if (inspected.status !== "configured_unavailable" || inspected.ref.source !== "env") {
      return false;
    }
    const envVarName = inspected.ref.id.trim();
    const resolvable =
      canResolveEnvSecretRefInReadOnlyPath({
        cfg,
        provider: inspected.ref.provider,
        id: envVarName,
      }) && Boolean(normalizeSecretInputString(process.env[envVarName]));
    return !resolvable;
  });
}

export function isComfyCapabilityConfigured(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  capability: ComfyCapability;
}): boolean {
  const { config } = getComfyConfig(params.cfg);
  const capabilityConfig = getComfyCapabilityConfig(config, params.capability);
  const hasWorkflow = Boolean(
    isRecord(capabilityConfig.workflow) || normalizeOptionalString(capabilityConfig.workflowPath),
  );
  const hasPromptNode = Boolean(normalizeOptionalString(capabilityConfig.promptNodeId));
  if (!hasWorkflow || !hasPromptNode) {
    return false;
  }
  if (hasUnavailableComfyHeaderSecret(capabilityConfig.headers, params.cfg)) {
    return false;
  }
  if (resolveComfyMode(capabilityConfig) === "local") {
    return true;
  }
  const configuredApiKey = resolveComfyApiKey(capabilityConfig, params.cfg);
  if (configuredApiKey.status === "available") {
    return true;
  }
  if (configuredApiKey.status === "configured_unavailable") {
    return false;
  }
  return isProviderApiKeyConfigured({
    provider: "comfy",
    cfg: params.cfg,
    agentDir: params.agentDir,
  });
}

export async function runComfyWorkflow(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  capability: ComfyCapability;
  inputImage?: ComfySourceImage;
}): Promise<ComfyWorkflowResult> {
  const { config, path: configPath } = getComfyConfig(params.cfg);
  const capabilityConfig = getComfyCapabilityConfig(config, params.capability);
  const mode = resolveComfyMode(capabilityConfig);
  const workflow = await loadComfyWorkflow(capabilityConfig);
  const promptNodeId = normalizeOptionalString(capabilityConfig.promptNodeId);
  if (!promptNodeId) {
    throw new Error("plugins.entries.comfy.config.promptNodeId is required");
  }
  const promptInputName = normalizeOptionalString(capabilityConfig.promptInputName) ?? "text";
  const inputImageNodeId = normalizeOptionalString(capabilityConfig.inputImageNodeId);
  const inputImageInputName =
    normalizeOptionalString(capabilityConfig.inputImageInputName) ?? "image";
  const seedNodeId = normalizeOptionalString(capabilityConfig.seedNodeId);
  const seedInputName = normalizeOptionalString(capabilityConfig.seedInputName) ?? "seed";
  const outputNodeId = normalizeOptionalString(capabilityConfig.outputNodeId);
  const pollIntervalMs = resolvePositiveTimerTimeoutMs(
    readConfigInteger(capabilityConfig, "pollIntervalMs"),
    DEFAULT_POLL_INTERVAL_MS,
  );
  const timeoutMs = resolvePositiveTimerTimeoutMs(
    readConfigInteger(capabilityConfig, "timeoutMs") ?? params.timeoutMs,
    DEFAULT_TIMEOUT_MS,
  );
  const providerModel = normalizeOptionalString(params.model) || DEFAULT_COMFY_MODEL;

  setWorkflowInput(workflow, promptNodeId, promptInputName, params.prompt);

  if (seedNodeId) {
    setWorkflowInput(workflow, seedNodeId, seedInputName, randomInt(RANDOM_SEED_EXCLUSIVE_MAX));
  }

  const pluginApiKey = resolveComfyApiKey(capabilityConfig, params.cfg);
  const apiKey =
    mode === "cloud"
      ? pluginApiKey.status === "available"
        ? pluginApiKey.apiKey
        : pluginApiKey.status === "configured_unavailable"
          ? undefined
          : (
              await resolveApiKeyForProvider({
                provider: "comfy",
                cfg: params.cfg,
                agentDir: params.agentDir,
                store: params.authStore,
              })
            ).apiKey
      : undefined;
  if (mode === "cloud" && !apiKey) {
    throw new Error("Comfy Cloud API key missing");
  }

  const explicitAllowPrivateNetwork = asBoolean(capabilityConfig.allowPrivateNetwork) === true;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: normalizeOptionalString(capabilityConfig.baseUrl),
      defaultBaseUrl:
        mode === "cloud" ? DEFAULT_COMFY_CLOUD_BASE_URL : DEFAULT_COMFY_LOCAL_BASE_URL,
      allowPrivateNetwork: mode === "local" || explicitAllowPrivateNetwork,
      headers: await resolveComfyHeadersConfig(capabilityConfig.headers, params.cfg, configPath),
      defaultHeaders:
        mode === "cloud"
          ? {
              "X-API-Key": apiKey ?? "",
              "Content-Type": "application/json",
            }
          : {
              "Content-Type": "application/json",
            },
      provider: "comfy",
      capability: params.capability === "music" ? "audio" : params.capability,
      transport: "http",
    });
  const networkPolicy = resolveComfyNetworkPolicy({
    baseUrl,
    allowPrivateNetwork,
    explicitAllowPrivateNetwork,
    mode,
  });

  if (params.inputImage) {
    if (!inputImageNodeId) {
      throw new Error(
        "Comfy edit requests require plugins.entries.comfy.config.<capability>.inputImageNodeId to be configured",
      );
    }
    const uploadedName = await uploadInputImage({
      baseUrl,
      headers: new Headers(headers),
      timeoutMs,
      policy: networkPolicy,
      dispatcherPolicy,
      image: params.inputImage,
      mode,
      capability: params.capability,
    });
    setWorkflowInput(workflow, inputImageNodeId, inputImageInputName, uploadedName);
  }

  const submitPayload = {
    prompt: workflow,
    ...(mode === "cloud" && apiKey ? { extra_data: { api_key_comfy_org: apiKey } } : {}),
  };

  const promptResponse = await readJsonResponse<ComfyPromptResponse>({
    url: `${baseUrl}${mode === "cloud" ? "/api/prompt" : "/prompt"}`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(submitPayload),
    },
    timeoutMs,
    policy: networkPolicy,
    dispatcherPolicy,
    auditContext: `comfy-${params.capability}-generate`,
    errorPrefix: "Comfy workflow submit failed",
  });

  const promptId = normalizeOptionalString(promptResponse.prompt_id);
  if (!promptId) {
    throw new Error("Comfy workflow submit response missing prompt_id");
  }

  const history = await waitForComfyHistory({
    baseUrl,
    promptId,
    headers: new Headers(headers),
    timeoutMs,
    pollIntervalMs,
    policy: networkPolicy,
    dispatcherPolicy,
    mode,
  });

  const historyEntry = extractHistoryEntry(history, promptId);
  if (!historyEntry) {
    throw new Error(`Comfy history response missing outputs for prompt ${promptId}`);
  }

  const outputFiles = collectOutputFiles({
    history: historyEntry,
    outputNodeId,
    outputKinds:
      params.capability === "music"
        ? ["audio"]
        : params.capability === "video"
          ? ["images", "gifs", "videos"]
          : ["images"],
    capability: params.capability,
  });
  if (outputFiles.length === 0) {
    throw new Error(`Comfy workflow ${promptId} completed without ${params.capability} outputs`);
  }

  const assets: ComfyGeneratedAsset[] = [];
  const outputKind = params.capability === "music" ? "audio" : params.capability;
  const maxOutputBytes = resolveGeneratedMediaMaxBytes(params.cfg, outputKind);
  for (const output of outputFiles) {
    const downloaded = await downloadOutputFile({
      baseUrl,
      headers: new Headers(headers),
      timeoutMs,
      policy: networkPolicy,
      dispatcherPolicy,
      file: output.file,
      mode,
      capability: params.capability,
      maxBytes: maxOutputBytes,
    });
    assets.push({
      ...downloaded,
      metadata: { nodeId: output.nodeId, promptId },
    });
  }

  return {
    assets,
    model: providerModel,
    metadata: { promptId, outputNodeIds: uniqueStrings(outputFiles.map((entry) => entry.nodeId)) },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
