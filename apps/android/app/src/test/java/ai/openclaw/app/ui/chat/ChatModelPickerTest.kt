package ai.openclaw.app.ui.chat

import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.GatewayModelUnavailableReason
import ai.openclaw.app.parseGatewayModels
import ai.openclaw.app.ui.design.providerBrandTintArgb
import ai.openclaw.app.ui.design.providerFallbackLabel
import ai.openclaw.app.ui.design.providerIconSlug
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatModelPickerTest {
  @Test
  fun fastModeUsesPublishedModelCapabilityInsteadOfProviderName() {
    val catalog =
      parseGatewayModels(
        Json
          .parseToJsonElement(
            """[
      {"id":"standard","name":"Standard","provider":"openai","supportsFastMode":false,"input":["audio","document"],"supportsTools":false,"agentRuntime":{"id":"openclaw","source":"model"}},
      {"id":"priority","name":"Priority","provider":"openai","supportsFastMode":true},
      {"id":"quick","name":"Quick","provider":"fixture","supportsFastMode":true}
    ]""",
          ).jsonArray,
      )

    assertFalse(fastModeRequestSupportedForSelection("openai/standard", "openai", catalog))
    assertTrue(fastModeRequestSupportedForSelection("openai/priority", "openai", catalog))
    assertTrue(fastModeRequestSupportedForSelection("fixture/quick", "fixture", catalog))
    assertFalse(fastModeRequestSupportedForSelection("openai/unknown", "openai", catalog))
    assertTrue(catalog.first().supportsAudio)
    assertTrue(catalog.first().supportsDocuments)
    assertFalse(catalog.first().supportsVision)
    assertEquals(false, catalog.first().supportsTools)
    assertEquals("OpenClaw", catalog.first().runtimeName)
  }

  @Test
  fun providerQualifiedRefAddsProviderOnlyWhenNeeded() {
    assertEquals("anthropic/claude-opus-4", model(id = "claude-opus-4", provider = "anthropic").providerQualifiedRef())
    assertEquals("anthropic/claude-opus-4", model(id = "anthropic/claude-opus-4", provider = "anthropic").providerQualifiedRef())
  }

  @Test
  fun sectionsPreservePinAndRecentOrderAndKeepRemainingCatalogOrder() {
    val catalog =
      listOf(
        model(id = "a", provider = "one"),
        model(id = "b", provider = "two"),
        model(id = "c", provider = "one"),
        model(id = "d", provider = "three"),
      )

    val sections =
      chatModelPickerSections(
        catalog = catalog,
        favorites = listOf("one/c", "missing/model", "one/a"),
        recents = listOf("one/a", "three/d", "missing/recent"),
      )

    assertEquals(listOf("one/c", "one/a"), sections.pinned.map { it.providerQualifiedRef() })
    assertEquals(listOf("three/d"), sections.recent.map { it.providerQualifiedRef() })
    assertEquals(listOf("two/b"), sections.remaining.map { it.providerQualifiedRef() })
  }

  @Test
  fun thinkingUsesPublishedChoicesAndUnknownModelsOfferNone() {
    val catalog =
      parseGatewayModels(
        Json
          .parseToJsonElement(
            """[
      {"id":"reasoning","name":"Reasoning","provider":"fixture","thinkingLevels":[{"id":"off","label":"Off"},{"id":"deep","label":"Deep"}]},
      {"id":"plain","name":"Plain","provider":"fixture","reasoning":true,"thinkingLevels":[]}
    ]""",
          ).jsonArray,
      )
    assertFalse(thinkingSupportedForSelection(null, catalog))
    assertFalse(thinkingSupportedForSelection("fixture/unknown", catalog))
    assertTrue(thinkingSupportedForSelection("fixture/reasoning", catalog))
    assertFalse(thinkingSupportedForSelection("fixture/plain", catalog))
  }

  @Test
  fun savedFastOverrideCanBeClearedWithoutAdvertisingSupport() {
    assertTrue(fastModeSupportedForSelection(requestSupported = false, hasConfiguredFastModeOverride = true))
    assertFalse(fastModeSupportedForSelection(requestSupported = false, hasConfiguredFastModeOverride = false))
  }

  @Test
  fun providerIconsFollowCanonicalWebAliasesAndSafeFallbacks() {
    mapOf(
      "amazon-bedrock" to "bedrock",
      "anthropic" to "claude",
      "aws-bedrock" to "bedrock",
      "claude-cli" to "claude",
      "cloudflare-ai-gateway" to "cloudflare",
      "copilot-proxy" to "copilot",
      "github-copilot" to "copilot",
      "google" to "gemini",
      "google-gemini-cli" to "gemini",
      "kilocode" to "kilo",
      "kimi-coding" to "kimi",
      "microsoft-foundry" to "microsoft",
      "minimax-portal" to "minimax",
      "moonshot" to "kimi",
      "ollama-cloud" to "ollama",
      "open-router" to "openrouter",
      "openai" to "codex",
      "qwen" to "alibaba",
      "qwen-token-plan" to "alibaba",
      "stepfun-plan" to "stepfun",
      "tencent-tokenhub" to "tencent",
      "tencent-tokenplan" to "tencent",
      "vercel-ai-gateway" to "vercel",
      "vertex-ai" to "vertexai",
      "xAI" to "grok",
      "xiaomi" to "mimo",
      "xiaomi-token-plan" to "mimo",
    ).forEach { (provider, slug) ->
      assertEquals(provider, slug, providerIconSlug(provider))
    }
    assertEquals("O", providerFallbackLabel(" openai"))
    assertEquals("", providerFallbackLabel(" -- "))
    assertEquals(0xFF10A37FL, providerBrandTintArgb("codex"))
    assertEquals(0xFFD97757L, providerBrandTintArgb("claude"))
    assertEquals(0xFF4285F4L, providerBrandTintArgb("gemini"))
    assertEquals(null, providerBrandTintArgb("openrouter"))
  }

  @Test
  fun unavailableReasonRequiresEveryMatchingRouteToBePermanentlyUnavailable() {
    val missing = model(id = "chat", provider = "synthetic", available = false, reason = GatewayModelUnavailableReason.MissingAuth)
    val failed = missing.copy(unavailableReason = GatewayModelUnavailableReason.AuthFailed)
    val cooling = missing.copy(unavailableReason = GatewayModelUnavailableReason.Cooldown)

    assertEquals(GatewayModelUnavailableReason.MissingAuth, selectedChatModelSendUnavailableReason("synthetic/chat", listOf(missing)))
    assertEquals(GatewayModelUnavailableReason.AuthFailed, selectedChatModelSendUnavailableReason("SYNTHETIC/CHAT", listOf(missing, failed)))
    assertEquals(GatewayModelUnavailableReason.Cooldown, selectedChatModelUnavailableReason("synthetic/chat", listOf(failed, cooling)))
    assertEquals(null, selectedChatModelSendUnavailableReason("synthetic/chat", listOf(failed, cooling)))
    assertEquals(null, selectedChatModelUnavailableReason("synthetic/chat", listOf(missing, missing.copy(available = true))))
    assertEquals(null, selectedChatModelUnavailableReason("synthetic/chat", listOf(missing, missing.copy(unavailableReason = null))))
    assertEquals(null, selectedChatModelUnavailableReason("synthetic/unknown", listOf(missing)))
  }

  @Test
  fun pickerRoutesAuthFailuresToProvidersAndDisablesOtherUnavailableRows() {
    assertEquals(ChatModelPickerAction.Select, chatModelPickerAction(model(id = "ready", provider = "synthetic")))
    assertEquals(
      ChatModelPickerAction.OpenProviders,
      chatModelPickerAction(model(id = "missing", provider = "synthetic", available = false, reason = GatewayModelUnavailableReason.MissingAuth)),
    )
    assertEquals(
      ChatModelPickerAction.Disabled,
      chatModelPickerAction(model(id = "cooling", provider = "synthetic", available = false, reason = GatewayModelUnavailableReason.Cooldown)),
    )
    assertEquals(ChatModelPickerAction.Disabled, chatModelPickerAction(model(id = "unknown", provider = "synthetic", available = false)))
  }

  @Test
  fun permanentAuthGateFailsOpenWhenGatewayIsNotReady() {
    val missing = model(id = "chat", provider = "synthetic", available = false, reason = GatewayModelUnavailableReason.MissingAuth)

    assertEquals(
      GatewayModelUnavailableReason.MissingAuth,
      selectedChatModelSendBlockingReason(gatewayReady = true, selectedModelRef = "synthetic/chat", catalog = listOf(missing)),
    )
    assertEquals(
      null,
      selectedChatModelSendBlockingReason(gatewayReady = false, selectedModelRef = "synthetic/chat", catalog = listOf(missing)),
    )
    assertTrue(chatModelSendBlocked(gatewayReady = true, selectedModelRef = "synthetic/chat", catalog = listOf(missing)))
    assertFalse(chatModelSendBlocked(gatewayReady = false, selectedModelRef = "synthetic/chat", catalog = listOf(missing)))
    assertEquals(
      null,
      chatModelUnavailableText(
        selectedChatModelSendBlockingReason(gatewayReady = false, selectedModelRef = "synthetic/chat", catalog = listOf(missing)),
      ),
    )
  }

  private fun model(
    id: String,
    provider: String,
    supportsReasoning: Boolean = false,
    available: Boolean? = true,
    reason: GatewayModelUnavailableReason? = null,
  ): GatewayModelSummary =
    GatewayModelSummary(
      id = id,
      name = id.substringAfterLast('/'),
      provider = provider,
      available = available,
      unavailableReason = reason,
      supportsVision = false,
      supportsAudio = false,
      supportsVideo = false,
      supportsDocuments = false,
      supportsReasoning = supportsReasoning,
      contextTokens = null,
    )
}
