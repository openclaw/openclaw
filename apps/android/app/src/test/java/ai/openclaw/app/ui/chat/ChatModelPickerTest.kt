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
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatModelPickerTest {
  @Test
  fun searchRanksExactNamesThenLiteralTermsThenTyposDeterministically() {
    val catalog =
      listOf(
        model(id = "atlas-plus", provider = "synthetic").copy(name = "Atlas Chat Plus"),
        model(id = "atals", provider = "synthetic").copy(name = "Atals Chat"),
        model(id = "atlas", provider = "synthetic").copy(name = "Atlas Chat"),
        model(id = "atlas", provider = "other").copy(name = "Atlas Chat"),
      )
    val cases =
      mapOf(
        "Atlas Chat" to listOf("other/atlas", "synthetic/atlas", "synthetic/atlas-plus", "synthetic/atals"),
        "synthetic/atlas" to listOf("synthetic/atlas", "synthetic/atlas-plus", "synthetic/atals"),
        "atals" to listOf("synthetic/atals", "other/atlas", "synthetic/atlas", "synthetic/atlas-plus"),
        "  SYNTHETIC   chat  " to listOf("synthetic/atals", "synthetic/atlas", "synthetic/atlas-plus"),
      )
    for ((query, expected) in cases) {
      assertEquals(query, expected, ChatModelSearch(catalog).search(query).map { it.providerQualifiedRef() })
      assertEquals(query, expected, ChatModelSearch(catalog.reversed()).search(query).map { it.providerQualifiedRef() })
    }
    assertSame(catalog, ChatModelSearch(catalog).search("  "))
  }

  @Test
  fun searchToleratesOneWordEditButRequiresEveryTermAndLiteralVersions() {
    val atlas = model(id = "atlas-chat-4.5", provider = "synthetic").copy(name = "Atlas Chat")
    val search = ChatModelSearch(listOf(atlas))
    for (query in listOf("atals", "atls", "atllas", "atlos", "synthtic atlas", "chat atlas", "atlas chta", "synthetic atlas 4.5")) {
      assertEquals(query, listOf(atlas), search.search(query))
    }
    for (query in listOf("unrelated", "atlas unrelated", "atlas 4.6", "atlas 4.55", "atlas cht", "xxlas", "///")) {
      assertTrue(query, search.search(query).isEmpty())
    }
    val local = atlas.copy(provider = "ollama")
    assertEquals(listOf(local), ChatModelSearch(listOf(local)).search("local atlas"))
  }

  @Test
  fun searchProjectsExistingChoicesWithoutChangingAvailability() {
    val ready = model(id = "atlas-ready", provider = "synthetic")
    val unavailable = model(id = "atlas-cooling", provider = "synthetic", available = false, reason = GatewayModelUnavailableReason.Cooldown)
    val restricted = model(id = "atlas-restricted", provider = "synthetic").copy(manualSelectionAllowed = false)
    val choices = chatModelPickerChoices(listOf(ready, unavailable, restricted), emptyList(), emptyList())
    val matches = ChatModelSearch(choices).search("atals")
    assertEquals(listOf(unavailable, ready), matches)
    assertSame(unavailable, matches.first())
    assertSame(ready, matches.last())
  }

  @Test
  fun fastModeUsesPublishedModelCapabilityInsteadOfProviderName() {
    val catalog =
      parseGatewayModels(
        Json
          .parseToJsonElement(
            """[
      {"id":"standard","name":"Standard","provider":"openai","manualSelectionAllowed":false,"supportsFastMode":false,"input":["audio","document"],"supportsTools":false,"agentRuntime":{"id":"openclaw","source":"model"}},
      {"id":"priority","name":"Priority","provider":"openai","manualSelectionAllowed":false,"supportsFastMode":true},
      {"id":"quick","name":"Quick","provider":"fixture","manualSelectionAllowed":true,"supportsFastMode":true},
      {"id":"legacy","name":"Legacy","provider":"fixture"}
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
    assertEquals(ChatModelPickerAction.Disabled, chatModelPickerAction(catalog[0]))
    assertEquals(ChatModelPickerAction.Disabled, chatModelPickerAction(catalog[1]))
    assertEquals(ChatModelPickerAction.Select, chatModelPickerAction(catalog[2]))
    assertEquals(ChatModelPickerAction.Select, chatModelPickerAction(catalog[3]))
    val choices = chatModelPickerChoices(catalog, listOf("openai/standard"), listOf("openai/priority"))
    assertEquals(listOf("fixture/quick", "fixture/legacy"), choices.map { it.providerQualifiedRef() })
    assertFalse(chatModelSendBlocked(true, "openai/standard", catalog))
  }

  @Test
  fun providerQualifiedRefAddsProviderOnlyWhenNeeded() {
    assertEquals("anthropic/claude-opus-4", model(id = "claude-opus-4", provider = "anthropic").providerQualifiedRef())
    assertEquals("anthropic/claude-opus-4", model(id = "anthropic/claude-opus-4", provider = "anthropic").providerQualifiedRef())
  }

  @Test
  fun choicesPreservePinAndRecentOrderAndKeepRemainingCatalogOrder() {
    val catalog =
      listOf(
        model(id = "a", provider = "one"),
        model(id = "b", provider = "two"),
        model(id = "c", provider = "one"),
        model(id = "d", provider = "three"),
      )

    val choices =
      chatModelPickerChoices(
        catalog = catalog,
        favorites = listOf("one/c", "missing/model", "one/a"),
        recents = listOf("one/a", "three/d", "missing/recent"),
      )

    assertEquals(listOf("one/c", "one/a", "three/d", "two/b"), choices.map { it.providerQualifiedRef() })
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
