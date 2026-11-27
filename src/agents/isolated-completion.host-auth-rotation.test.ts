import fs from "node:fs";
import { text as readText } from "node:stream/consumers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isProfileInCooldown } from "./auth-profiles/usage-state.js";
import { runIsolatedCompletion } from "./isolated-completion.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
import { ensureAuthProfileStoreAsync } from "./model-auth.js";
import { prepareUtilityCompletionForAgent, runUtilityCompletion } from "./utility-completion.js";

const OPUS_MODEL = "claude-opus-5-5";
const HAIKU_MODEL = "claude-haiku-5-5";
const LUNA_MODEL = "gpt-6-luna";
const TOKEN_A = "fixture-anthropic-token-alpha-999";
const TOKEN_B = "fixture-anthropic-token-beta-888";
const APIKEY_C = "fixture-anthropic-apikey-gamma-777";
const OPENAI_KEY = "fixture-openai-fallback-delta-666";
const HAIKU_PROFILES = ["anthropic:token-a", "anthropic:token-b", "anthropic:apikey-c"];

const logPaths = createSuiteLogPathTracker("isolated-completion-host-auth-rotation-");
beforeAll(() => logPaths.setup());
afterAll(() => logPaths.cleanup());

const anthropicSse = (text: string) =>
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fx","usage":{"input_tokens":8,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n` +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

const openaiSse = (text: string) =>
  `data: ${JSON.stringify({ id: "chatcmpl-fx", object: "chat.completion.chunk", created: 0, model: LUNA_MODEL, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`;

type RecordedRequest = { provider: "anthropic" | "openai"; model: string; credential: string };
type FixtureCtx = {
  requests: RecordedRequest[];
  consoleWarn: ReturnType<typeof vi.fn>;
  runUtility: (preferredProfile?: string) => ReturnType<typeof runUtilityCompletion>;
  probeOpus: () => ReturnType<typeof runIsolatedCompletion>;
  readStore: () => Promise<AuthProfileStore>;
  readDecisionLogs: () => Promise<{ raw: string; events: Array<Record<string, unknown>> }>;
};

async function withUtilityProviderFixture(
  options: { haikuHealthy?: ReadonlySet<string>; opusHealthy?: ReadonlySet<string> },
  run: (fixture: FixtureCtx) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ label: "utility-host-auth-rotation" }, async (state) => {
    const requests: RecordedRequest[] = [];
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "anthropic:token-a": { type: "token", provider: "anthropic", token: TOKEN_A },
        "anthropic:token-b": { type: "token", provider: "anthropic", token: TOKEN_B },
        "anthropic:apikey-c": { type: "api_key", provider: "anthropic", key: APIKEY_C },
      },
    });
    const previousConsole = loggingState.rawConsole;
    const consoleWarn = vi.fn();
    const logFilePath = logPaths.nextPath();
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn: consoleWarn, error: vi.fn() };
    setLoggerOverride({
      level: "warn",
      consoleLevel: "warn",
      consoleStyle: "compact",
      file: logFilePath,
    });
    try {
      await withServer(
        (req, res) => {
          void readText(req).then((raw) => {
            const model = (JSON.parse(raw) as { model?: string }).model ?? "";
            const isOpenAi = req.url?.startsWith("/openai");
            const credential =
              typeof req.headers["x-api-key"] === "string"
                ? req.headers["x-api-key"]
                : typeof req.headers.authorization === "string"
                  ? req.headers.authorization.replace(/^Bearer\s+/i, "")
                  : "";
            requests.push({ provider: isOpenAi ? "openai" : "anthropic", model, credential });
            if (isOpenAi) {
              res.writeHead(200, { "content-type": "text/event-stream" });
              res.end(openaiSse("Luna fallback result"));
              return;
            }
            const healthy = model === OPUS_MODEL ? options.opusHealthy : options.haikuHealthy;
            if (healthy?.has(credential)) {
              res.writeHead(200, { "content-type": "text/event-stream" });
              res.end(
                anthropicSse(model === OPUS_MODEL ? "Opus healthy reply" : "Haiku rotated title"),
              );
              return;
            }
            res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
            res.end(
              JSON.stringify({
                type: "error",
                error: {
                  type: "rate_limit_error",
                  message: `Rate limit for ${model} ${credential}`,
                },
              }),
            );
          });
        },
        async (baseUrl) => {
          const makeProvider = (
            subpath: string,
            api: "anthropic-messages" | "openai-completions",
            ids: string[],
            apiKey?: string,
          ) => ({
            baseUrl: `${baseUrl}/${subpath}`,
            api,
            ...(apiKey ? { apiKey } : {}),
            agentRuntime: { id: "openclaw" as const },
            request: { allowPrivateNetwork: true },
            models: ids.map((id) =>
              modelDefinition(id, { api, reasoning: false, contextWindow: 32_000 }),
            ),
          });
          const cfg: OpenClawConfig = {
            plugins: { enabled: false },
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                skipBootstrap: true,
                model: { primary: `anthropic/${OPUS_MODEL}` },
                utilityModel: {
                  primary: `anthropic/${HAIKU_MODEL}`,
                  fallbacks: [`openai/${LUNA_MODEL}`],
                },
              },
            },
            models: {
              mode: "replace",
              providers: {
                anthropic: makeProvider("anthropic", "anthropic-messages", [
                  OPUS_MODEL,
                  HAIKU_MODEL,
                ]),
                openai: makeProvider("openai/v1", "openai-completions", [LUNA_MODEL], OPENAI_KEY),
              },
            },
          };
          setRuntimeConfigSnapshot(cfg);
          const agentDir = state.agentDir();
          const runUtility = async (preferredProfile?: string) => {
            const prepared = await prepareUtilityCompletionForAgent({
              cfg,
              agentId: "main",
              useUtilityModel: "required",
              ...(preferredProfile ? { preferredProfile } : {}),
            });
            return await runUtilityCompletion({
              ...prepared,
              prompt: "Generate a short title.",
              systemPrompt: "Return a concise title.",
              timeoutMs: 20_000,
            });
          };
          const probeOpus = () =>
            runIsolatedCompletion({
              config: cfg,
              provider: "anthropic",
              model: OPUS_MODEL,
              authProfileId: "anthropic:token-a",
              agentId: "main",
              agentDir,
              prompt: "Ping",
              systemPrompt: "Reply briefly.",
              timeoutMs: 20_000,
            });
          const readStore = () =>
            ensureAuthProfileStoreAsync(agentDir, {
              readOnly: true,
              allowKeychainPrompt: false,
              config: cfg,
            });
          const readDecisionLogs = async () => {
            await flushLogger();
            const raw = fs.existsSync(logFilePath) ? fs.readFileSync(logFilePath, "utf8") : "";
            const events = raw
              .split("\n")
              .filter(Boolean)
              .map((line) => (JSON.parse(line) as Record<string, unknown>)["1"])
              .filter(
                (p): p is Record<string, unknown> =>
                  Boolean(p) &&
                  typeof p === "object" &&
                  (p as Record<string, unknown>).event === "isolated_completion_auth_exhausted",
              );
            return { raw, events };
          };
          await run({ requests, consoleWarn, runUtility, probeOpus, readStore, readDecisionLogs });
        },
      );
    } finally {
      await flushLogger();
      setLoggerOverride(null);
      resetLogger();
      loggingState.rawConsole = previousConsole;
      clearRuntimeConfigSnapshot();
    }
  });
}

describe("built-in host-auth utility profile rotation (#204811)", () => {
  it("rotates across two 429 token profiles onto a healthy API-key profile before cross-provider fallback", async () => {
    await withUtilityProviderFixture(
      { haikuHealthy: new Set([APIKEY_C]) },
      async ({ requests, runUtility, readStore }) => {
        expect(await runUtility()).toMatchObject({
          text: "Haiku rotated title",
          provider: "anthropic",
          model: HAIKU_MODEL,
        });
        expect(requests.map((r) => [r.provider, r.model, r.credential])).toEqual([
          ["anthropic", HAIKU_MODEL, TOKEN_A],
          ["anthropic", HAIKU_MODEL, TOKEN_B],
          ["anthropic", HAIKU_MODEL, APIKEY_C],
        ]);
        const reloaded = await readStore();
        expect([
          isProfileInCooldown(reloaded, "anthropic:token-a", undefined, HAIKU_MODEL),
          isProfileInCooldown(reloaded, "anthropic:token-b", undefined, HAIKU_MODEL),
          isProfileInCooldown(reloaded, "anthropic:token-a", undefined, OPUS_MODEL),
          isProfileInCooldown(reloaded, "anthropic:apikey-c", undefined, HAIKU_MODEL),
        ]).toEqual([true, true, false, false]);
      },
    );
  });

  it("exhausts Haiku across all three profiles while Opus stays healthy, records non-secret outcomes, and falls back", async () => {
    await withUtilityProviderFixture(
      { opusHealthy: new Set([TOKEN_A]), haikuHealthy: new Set() },
      async ({ requests, consoleWarn, runUtility, probeOpus, readStore, readDecisionLogs }) => {
        expect(await probeOpus()).toMatchObject({ text: "Opus healthy reply", model: OPUS_MODEL });
        requests.length = 0;

        expect(await runUtility()).toMatchObject({
          text: "Luna fallback result",
          provider: "openai",
          model: LUNA_MODEL,
        });
        expect(requests.map((r) => [r.provider, r.model, r.credential])).toEqual([
          ["anthropic", HAIKU_MODEL, TOKEN_A],
          ["anthropic", HAIKU_MODEL, TOKEN_B],
          ["anthropic", HAIKU_MODEL, APIKEY_C],
          ["openai", LUNA_MODEL, OPENAI_KEY],
        ]);

        const { raw, events } = await readDecisionLogs();
        expect(events).toMatchObject([
          {
            provider: "anthropic",
            model: HAIKU_MODEL,
            profileCount: 3,
            failedProfileCount: 3,
            reason: "eligible_profiles_exhausted",
            attempts: HAIKU_PROFILES.map((profileId) =>
              expect.objectContaining({
                profileId,
                reason: "rate_limit",
                status: 429,
                rateLimitResetAt: expect.any(Number),
              }),
            ),
          },
        ]);
        const combinedLogs = `${raw}\n${JSON.stringify(consoleWarn.mock.calls)}`;
        for (const secret of [TOKEN_A, TOKEN_B, APIKEY_C, OPENAI_KEY]) {
          expect(combinedLogs).not.toContain(secret);
        }
        const reloaded = await readStore();
        for (const id of HAIKU_PROFILES) {
          expect(isProfileInCooldown(reloaded, id, undefined, HAIKU_MODEL)).toBe(true);
          expect(isProfileInCooldown(reloaded, id, undefined, OPUS_MODEL)).toBe(false);
        }

        // Subsequent Haiku utility call skips cooled profiles while Opus on token-a stays healthy.
        requests.length = 0;
        expect(await runUtility()).toMatchObject({ provider: "openai", model: LUNA_MODEL });
        expect(requests.map((r) => [r.provider, r.model])).toEqual([["openai", LUNA_MODEL]]);
        const afterCooldown = (await readDecisionLogs()).events;
        expect(afterCooldown.at(-1)).toMatchObject({
          provider: "anthropic",
          model: HAIKU_MODEL,
          reason: "all_profiles_in_cooldown",
          rateLimitResetAt: expect.any(Number),
        });
        expect((await probeOpus()).text).toBe("Opus healthy reply");
      },
    );
  });

  it("respects an explicit authProfileId pin without rotating to sibling profiles", async () => {
    await withUtilityProviderFixture(
      { haikuHealthy: new Set([APIKEY_C]) },
      async ({ requests, runUtility }) => {
        expect(await runUtility("anthropic:token-a")).toMatchObject({
          provider: "openai",
          model: LUNA_MODEL,
        });
        expect(requests.map((r) => [r.provider, r.model, r.credential])).toEqual([
          ["anthropic", HAIKU_MODEL, TOKEN_A],
          ["openai", LUNA_MODEL, OPENAI_KEY],
        ]);
      },
    );
  });
});
