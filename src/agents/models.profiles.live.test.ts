import { type Api, completeSimple, type Model } from "@mariozechner/pi-ai";
import {
  discoverAuthStorage,
  discoverModels,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/config.js";
import { resolveClawdbotAgentDir } from "./agent-paths.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { getApiKeyForModel } from "./model-auth.js";
import {
  buildModelAliasIndex,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection.js";
import { ensureClawdbotModelsJson } from "./models-config.js";

const LIVE = process.env.LIVE === "1" || process.env.CLAWDBOT_LIVE_TEST === "1";
const ALL_MODELS =
  process.env.CLAWDBOT_LIVE_ALL_MODELS === "1" ||
  process.env.CLAWDBOT_LIVE_MODELS === "all";
const REQUIRE_PROFILE_KEYS =
  process.env.CLAWDBOT_LIVE_REQUIRE_PROFILE_KEYS === "1";

const describeLive = LIVE && ALL_MODELS ? describe : describe.skip;

function parseProviderFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") return null;
  const ids = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function parseModelFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") return null;
  const ids = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function isGoogleModelNotFoundError(err: unknown): boolean {
  const msg = String(err);
  if (!/not found/i.test(msg)) return false;
  if (/models\/.+ is not found for api version/i.test(msg)) return true;
  if (/"status"\\s*:\\s*"NOT_FOUND"/.test(msg)) return true;
  if (/"code"\\s*:\\s*404/.test(msg)) return true;
  return false;
}

function isModelNotFoundErrorMessage(raw: string): boolean {
  const msg = raw.trim();
  if (!msg) return false;
  if (/\b404\b/.test(msg) && /not[_-]?found/i.test(msg)) return true;
  if (/not_found_error/i.test(msg)) return true;
  if (/model:\s*[a-z0-9._-]+/i.test(msg) && /not[_-]?found/i.test(msg))
    return true;
  return false;
}

function toInt(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function completeSimpleWithTimeout<TApi extends Api>(
  model: Model<TApi>,
  context: Parameters<typeof completeSimple<TApi>>[1],
  options: Parameters<typeof completeSimple<TApi>>[2],
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    return await completeSimple(model, context, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function completeOkWithRetry(params: {
  model: Model<Api>;
  apiKey: string;
  timeoutMs: number;
}) {
  const runOnce = async () => {
    const res = await completeSimpleWithTimeout(
      params.model,
      {
        messages: [
          {
            role: "user",
            content: "Reply with the word ok.",
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: params.apiKey,
        reasoning: params.model.reasoning ? "low" : undefined,
        maxTokens: 64,
      },
      params.timeoutMs,
    );
    const text = res.content
      .filter((block) => block.type === "text")
      .map((block) => block.text.trim())
      .join(" ");
    return { res, text };
  };

  const first = await runOnce();
  if (first.text.length > 0) return first;
  return await runOnce();
}

function resolveConfiguredModelKeys(
  cfg: ReturnType<typeof loadConfig>,
): string[] {
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const order: string[] = [];
  const seen = new Set<string>();

  const addKey = (key: string) => {
    const normalized = key.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    order.push(normalized);
  };

  const addRef = (ref: { provider: string; model: string }) => {
    addKey(`${ref.provider}/${ref.model}`);
  };

  addRef(
    resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    }),
  );

  const modelConfig = cfg.agents?.defaults?.model as
    | { primary?: string; fallbacks?: string[] }
    | undefined;
  const imageModelConfig = cfg.agents?.defaults?.imageModel as
    | { primary?: string; fallbacks?: string[] }
    | undefined;

  const primary = modelConfig?.primary?.trim() ?? "";
  const fallbacks = modelConfig?.fallbacks ?? [];
  const imagePrimary = imageModelConfig?.primary?.trim() ?? "";
  const imageFallbacks = imageModelConfig?.fallbacks ?? [];

  const addRaw = (raw: string) => {
    const resolved = resolveModelRefFromString({
      raw,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (resolved) addRef(resolved.ref);
  };

  if (primary) addRaw(primary);
  for (const raw of fallbacks) addRaw(String(raw ?? ""));
  if (imagePrimary) addRaw(imagePrimary);
  for (const raw of imageFallbacks) addRaw(String(raw ?? ""));

  for (const key of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    const parsed = parseModelRef(String(key ?? ""), DEFAULT_PROVIDER);
    if (parsed) addRef(parsed);
  }

  return order;
}

describeLive("live models (profile keys)", () => {
  it(
    "completes across configured models",
    async () => {
      const cfg = loadConfig();
      await ensureClawdbotModelsJson(cfg);

      const agentDir = resolveClawdbotAgentDir();
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const models = modelRegistry.getAll() as Array<Model<Api>>;
      const modelByKey = new Map(
        models.map((model) => [`${model.provider}/${model.id}`, model]),
      );

      const filter = parseModelFilter(process.env.CLAWDBOT_LIVE_MODELS);
      const providers = parseProviderFilter(
        process.env.CLAWDBOT_LIVE_PROVIDERS,
      );
      const perModelTimeoutMs = toInt(
        process.env.CLAWDBOT_LIVE_MODEL_TIMEOUT_MS,
        30_000,
      );

      const failures: Array<{ model: string; error: string }> = [];
      const skipped: Array<{ model: string; reason: string }> = [];

      const configuredKeys = resolveConfiguredModelKeys(cfg);

      for (const key of configuredKeys) {
        const model = modelByKey.get(key);
        if (!model) {
          skipped.push({
            model: key,
            reason: "configured model missing in registry",
          });
          continue;
        }
        if (providers && !providers.has(model.provider)) continue;
        const id = `${model.provider}/${model.id}`;
        if (filter && !filter.has(id)) continue;

        let apiKeyInfo: Awaited<ReturnType<typeof getApiKeyForModel>>;
        try {
          apiKeyInfo = await getApiKeyForModel({ model, cfg });
        } catch (err) {
          skipped.push({ model: id, reason: String(err) });
          continue;
        }

        if (REQUIRE_PROFILE_KEYS && !apiKeyInfo.source.startsWith("profile:")) {
          skipped.push({
            model: id,
            reason: `non-profile credential source: ${apiKeyInfo.source}`,
          });
          continue;
        }

        try {
          // Special regression: OpenAI requires replayed `reasoning` items for tool-only turns.
          if (
            model.provider === "openai" &&
            model.api === "openai-responses" &&
            model.id === "gpt-5.2"
          ) {
            const noopTool = {
              name: "noop",
              description: "Return ok.",
              parameters: Type.Object({}, { additionalProperties: false }),
            };

            const first = await completeSimpleWithTimeout(
              model,
              {
                messages: [
                  {
                    role: "user",
                    content:
                      "Call the tool `noop` with {}. Do not write any other text.",
                    timestamp: Date.now(),
                  },
                ],
                tools: [noopTool],
              },
              {
                apiKey: apiKeyInfo.apiKey,
                reasoning: model.reasoning ? "low" : undefined,
                maxTokens: 128,
              },
              perModelTimeoutMs,
            );

            const toolCall = first.content.find((b) => b.type === "toolCall");
            expect(toolCall).toBeTruthy();
            if (!toolCall || toolCall.type !== "toolCall") {
              throw new Error("expected tool call");
            }

            const second = await completeSimpleWithTimeout(
              model,
              {
                messages: [
                  {
                    role: "user",
                    content:
                      "Call the tool `noop` with {}. Do not write any other text.",
                    timestamp: Date.now(),
                  },
                  first,
                  {
                    role: "toolResult",
                    toolCallId: toolCall.id,
                    toolName: "noop",
                    content: [{ type: "text", text: "ok" }],
                    isError: false,
                    timestamp: Date.now(),
                  },
                  {
                    role: "user",
                    content: "Reply with the word ok.",
                    timestamp: Date.now(),
                  },
                ],
              },
              {
                apiKey: apiKeyInfo.apiKey,
                reasoning: model.reasoning ? "low" : undefined,
                maxTokens: 64,
              },
              perModelTimeoutMs,
            );

            const secondText = second.content
              .filter((b) => b.type === "text")
              .map((b) => b.text.trim())
              .join(" ");
            expect(secondText.length).toBeGreaterThan(0);
            continue;
          }

          const ok = await completeOkWithRetry({
            model,
            apiKey: apiKeyInfo.apiKey,
            timeoutMs: perModelTimeoutMs,
          });

          if (ok.res.stopReason === "error") {
            const msg = ok.res.errorMessage ?? "";
            if (ALL_MODELS && isModelNotFoundErrorMessage(msg)) {
              skipped.push({ model: id, reason: msg });
              continue;
            }
            throw new Error(msg || "model returned error with no message");
          }

          if (ok.text.length === 0 && model.provider === "google") {
            skipped.push({
              model: id,
              reason: "no text returned (likely unavailable model id)",
            });
            continue;
          }
          expect(ok.text.length).toBeGreaterThan(0);
        } catch (err) {
          if (model.provider === "google" && isGoogleModelNotFoundError(err)) {
            skipped.push({ model: id, reason: String(err) });
            continue;
          }
          failures.push({ model: id, error: String(err) });
        }
      }

      if (failures.length > 0) {
        const preview = failures
          .slice(0, 10)
          .map((f) => `- ${f.model}: ${f.error}`)
          .join("\n");
        throw new Error(
          `live model failures (${failures.length}):\n${preview}`,
        );
      }

      // Keep one assertion so the test fails loudly if we somehow ran nothing.
      expect(models.length).toBeGreaterThan(0);
      void skipped;
    },
    15 * 60 * 1000,
  );
});
