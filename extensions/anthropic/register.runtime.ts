import { formatCliCommand } from 'openclaw/plugin-sdk/cli-runtime'
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from 'openclaw/plugin-sdk/plugin-entry'
import {
  createProviderApiKeyAuthMethod,
  listProfilesForProvider,
  suggestOAuthProfileIdForLegacyDefault,
  type AuthProfileStore,
} from 'openclaw/plugin-sdk/provider-auth'
import { cloneFirstTemplateModel } from 'openclaw/plugin-sdk/provider-model-shared'
import { fetchClaudeUsage } from 'openclaw/plugin-sdk/provider-usage'
import { buildAnthropicCliBackend } from './cli-backend.js'
import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfig,
} from './config-defaults.js'
import { anthropicMediaUnderstandingProvider } from './media-understanding-provider.js'
import { buildAnthropicReplayPolicy } from './replay-policy.js'
import { wrapAnthropicProviderStream } from './stream-wrappers.js'

const PROVIDER_ID = 'anthropic'
const ANTHROPIC_OPUS_46_MODEL_ID = 'claude-opus-4-6'
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = 'claude-opus-4.6'
const ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS = [
  'claude-opus-4-5',
  'claude-opus-4.5',
] as const
const ANTHROPIC_SONNET_46_MODEL_ID = 'claude-sonnet-4-6'
const ANTHROPIC_SONNET_46_DOT_MODEL_ID = 'claude-sonnet-4.6'
const ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS = [
  'claude-sonnet-4-5',
  'claude-sonnet-4.5',
] as const
const ANTHROPIC_MODERN_MODEL_PREFIXES = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const
function resolveAnthropic46ForwardCompatModel(params: {
  ctx: ProviderResolveDynamicModelContext
  dashModelId: string
  dotModelId: string
  dashTemplateId: string
  dotTemplateId: string
  fallbackTemplateIds: readonly string[]
}): ProviderRuntimeModel | undefined {
  const trimmedModelId = params.ctx.modelId.trim()
  const lower = trimmedModelId.toLowerCase()
  const is46Model =
    lower === params.dashModelId ||
    lower === params.dotModelId ||
    lower.startsWith(`${params.dashModelId}-`) ||
    lower.startsWith(`${params.dotModelId}-`)
  if (!is46Model) {
    return undefined
  }

  const templateIds: string[] = []
  if (lower.startsWith(params.dashModelId)) {
    templateIds.push(lower.replace(params.dashModelId, params.dashTemplateId))
  }
  if (lower.startsWith(params.dotModelId)) {
    templateIds.push(lower.replace(params.dotModelId, params.dotTemplateId))
  }
  templateIds.push(...params.fallbackTemplateIds)

  return cloneFirstTemplateModel({
    providerId: PROVIDER_ID,
    modelId: trimmedModelId,
    templateIds,
    ctx: params.ctx,
  })
}

function resolveAnthropicForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  return (
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_OPUS_46_MODEL_ID,
      dotModelId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
      dashTemplateId: 'claude-opus-4-5',
      dotTemplateId: 'claude-opus-4.5',
      fallbackTemplateIds: ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS,
    }) ??
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_SONNET_46_MODEL_ID,
      dotModelId: ANTHROPIC_SONNET_46_DOT_MODEL_ID,
      dashTemplateId: 'claude-sonnet-4-5',
      dotTemplateId: 'claude-sonnet-4.5',
      fallbackTemplateIds: ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS,
    })
  )
}

function matchesAnthropicModernModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase()
  return ANTHROPIC_MODERN_MODEL_PREFIXES.some(prefix =>
    lower.startsWith(prefix),
  )
}

function buildAnthropicAuthDoctorHint(params: {
  config?: ProviderAuthContext['config']
  store: AuthProfileStore
  profileId?: string
}): string {
  const legacyProfileId = params.profileId ?? 'anthropic:default'
  const suggested = suggestOAuthProfileIdForLegacyDefault({
    cfg: params.config,
    store: params.store,
    provider: PROVIDER_ID,
    legacyProfileId,
  })
  if (!suggested || suggested === legacyProfileId) {
    return ''
  }

  const storeOauthProfiles = listProfilesForProvider(params.store, PROVIDER_ID)
    .filter(id => params.store.profiles[id]?.type === 'oauth')
    .join(', ')

  const cfgMode = params.config?.auth?.profiles?.[legacyProfileId]?.mode
  const cfgProvider = params.config?.auth?.profiles?.[legacyProfileId]?.provider

  return [
    'Doctor hint (for GitHub issue):',
    `- provider: ${PROVIDER_ID}`,
    `- config: ${legacyProfileId}${
      cfgProvider || cfgMode
        ? ` (provider=${cfgProvider ?? '?'}, mode=${cfgMode ?? '?'})`
        : ''
    }`,
    `- auth store oauth profiles: ${storeOauthProfiles || '(none)'}`,
    `- suggested profile: ${suggested}`,
    `Fix: run "${formatCliCommand('openclaw doctor --yes')}"`,
  ].join('\n')
}

export function registerAnthropicPlugin(api: OpenClawPluginApi): void {
  const providerId = 'anthropic'
  const defaultAnthropicModel = 'anthropic/claude-sonnet-4-6'
  api.registerCliBackend(buildAnthropicCliBackend())
  api.registerProvider({
    id: providerId,
    label: 'Anthropic',
    docsPath: '/providers/models',
    envVars: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    deprecatedProfileIds: ['anthropic:claude-cli'],
    oauthProfileIdRepairs: [
      {
        legacyProfileId: 'anthropic:default',
        promptLabel: 'Anthropic',
      },
    ],
    auth: [
      createProviderApiKeyAuthMethod({
        providerId,
        methodId: 'api-key',
        label: 'Anthropic API key',
        hint: 'Direct Anthropic API key',
        optionKey: 'anthropicApiKey',
        flagName: '--anthropic-api-key',
        envVar: 'ANTHROPIC_API_KEY',
        promptMessage: 'Enter Anthropic API key',
        defaultModel: defaultAnthropicModel,
        expectedProviders: ['anthropic'],
        wizard: {
          choiceId: 'apiKey',
          choiceLabel: 'Anthropic API key',
          groupId: 'anthropic',
          groupLabel: 'Anthropic',
          groupHint: 'Anthropic API key',
        },
      }),
    ],
    normalizeConfig: ({ providerConfig }) =>
      normalizeAnthropicProviderConfig(providerConfig),
    applyConfigDefaults: ({ config, env }) =>
      applyAnthropicConfigDefaults({ config, env }),
    resolveDynamicModel: ctx => resolveAnthropicForwardCompatModel(ctx),
    buildReplayPolicy: buildAnthropicReplayPolicy,
    isModernModelRef: ({ modelId }) => matchesAnthropicModernModel(modelId),
    resolveReasoningOutputMode: () => 'native',
    wrapStreamFn: wrapAnthropicProviderStream,
    resolveDefaultThinkingLevel: ({ modelId }) =>
      matchesAnthropicModernModel(modelId) &&
      (modelId.toLowerCase().startsWith(ANTHROPIC_OPUS_46_MODEL_ID) ||
        modelId.toLowerCase().startsWith(ANTHROPIC_OPUS_46_DOT_MODEL_ID) ||
        modelId.toLowerCase().startsWith(ANTHROPIC_SONNET_46_MODEL_ID) ||
        modelId.toLowerCase().startsWith(ANTHROPIC_SONNET_46_DOT_MODEL_ID))
        ? 'adaptive'
        : undefined,
    resolveUsageAuth: async ctx => await ctx.resolveOAuthToken(),
    fetchUsageSnapshot: async ctx =>
      await fetchClaudeUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
    isCacheTtlEligible: () => true,
    buildAuthDoctorHint: ctx =>
      buildAnthropicAuthDoctorHint({
        config: ctx.config,
        store: ctx.store,
        profileId: ctx.profileId,
      }),
  })
  api.registerMediaUnderstandingProvider(anthropicMediaUnderstandingProvider)
}
