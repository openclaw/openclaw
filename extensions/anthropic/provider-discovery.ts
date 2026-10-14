/**
 * Claude CLI provider discovery descriptor. It exposes subscription-backed
 * synthetic auth for catalog/runtime discovery without full Anthropic registration.
 */
import type {
  ModelDefinitionConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { observeClaudeCliNativeLogin, type ClaudeCliNativeLogin } from "./cli-auth-seam.js";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_NATIVE_AUTH_MARKER } from "./cli-constants.js";
import { discoverClaudeCliModels } from "./cli-model-discovery.js";

const modelCaptures = new WeakMap<
  object,
  WeakMap<object, WeakMap<object, Promise<ModelDefinitionConfig[]>>>
>();

type NativeAvailability = {
  observedAt: number;
  sourceKey: string;
  pending: Promise<ClaudeCliNativeLogin>;
};
const availability = new WeakMap<object, WeakMap<object, WeakMap<object, NativeAvailability>>>();
const NATIVE_LOGIN_TTL_MS = 60_000;

async function prepareClaudeCliAuth({
  config,
  provider,
  env = process.env,
  signal,
}: Parameters<NonNullable<ProviderPlugin["prepareSyntheticAuth"]>>[0]) {
  signal?.throwIfAborted();
  if (!config || normalizeLowercaseStringOrEmpty(provider) !== CLAUDE_CLI_BACKEND_ID) {
    return undefined;
  }
  const environments =
    availability.get(config) ?? new WeakMap<object, WeakMap<object, NativeAvailability>>();
  availability.set(config, environments);
  const captures = environments.get(env) ?? new WeakMap<object, NativeAvailability>();
  environments.set(env, captures);
  // A capture coalesces a roster's reads. Even a capture without a signal expires.
  const owner = signal ?? config;
  const sourceKey = JSON.stringify([
    process.cwd(),
    env.HOME,
    env.USERPROFILE,
    env.USER,
    env.CLAUDE_CONFIG_DIR,
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  ]);
  const now = Date.now();
  let observation = captures.get(owner);
  if (
    !observation ||
    observation.sourceKey !== sourceKey ||
    now - observation.observedAt >= NATIVE_LOGIN_TTL_MS
  ) {
    const captured = {
      sourceKey,
      observedAt: now,
      pending: observeClaudeCliNativeLogin({ env, signal }),
    };
    observation = captured;
    captures.set(owner, captured);
    void captured.pending.catch(() => {
      if (captures.get(owner) === captured) {
        captures.delete(owner);
      }
    });
  }
  const result = await observation.pending;
  signal?.throwIfAborted();
  return {
    apiKey: CLAUDE_CLI_NATIVE_AUTH_MARKER,
    source: "Claude CLI native auth",
    mode: "oauth" as const,
    nativeAuth: { runtime: CLAUDE_CLI_BACKEND_ID, mode: "oauth" as const, ...result },
  };
}

const anthropicProviderDiscovery: ProviderPlugin = {
  id: CLAUDE_CLI_BACKEND_ID,
  label: "Claude CLI",
  docsPath: "/providers/models",
  auth: [],
  catalog: {
    order: "simple",
    async run(ctx) {
      if (ctx.providerIds && !ctx.providerIds.includes(CLAUDE_CLI_BACKEND_ID)) {
        return null;
      }
      const auth = await prepareClaudeCliAuth({
        config: ctx.config,
        provider: CLAUDE_CLI_BACKEND_ID,
        env: ctx.env,
        signal: ctx.signal,
      });
      if (auth?.nativeAuth.readiness === "missing") {
        return null;
      }
      ctx.signal?.throwIfAborted();
      const environments = modelCaptures.get(ctx.config) ?? new WeakMap();
      modelCaptures.set(ctx.config, environments);
      const captures = environments.get(ctx.env) ?? new WeakMap();
      environments.set(ctx.env, captures);
      const owner = ctx.signal ?? ctx.config;
      const pending = captures.get(owner) ?? discoverClaudeCliModels(ctx);
      captures.set(owner, pending);
      try {
        const models = await pending;
        ctx.signal?.throwIfAborted();
        return {
          providers: {
            [CLAUDE_CLI_BACKEND_ID]: {
              baseUrl: "https://api.anthropic.com",
              api: "anthropic-messages",
              models,
            },
          },
          outcomes: [
            {
              provider: CLAUDE_CLI_BACKEND_ID,
              status: "ready",
              listedModelIds: models.map((model) => model.id),
            },
          ],
        };
      } catch {
        ctx.signal?.throwIfAborted();
        return {
          providers: {
            [CLAUDE_CLI_BACKEND_ID]: {
              baseUrl: "https://api.anthropic.com",
              api: "anthropic-messages",
              models: [],
            },
          },
          outcomes: [{ provider: CLAUDE_CLI_BACKEND_ID, status: "unavailable" }],
        };
      }
    },
  },
  prepareSyntheticAuth: prepareClaudeCliAuth,
};

export default anthropicProviderDiscovery;
