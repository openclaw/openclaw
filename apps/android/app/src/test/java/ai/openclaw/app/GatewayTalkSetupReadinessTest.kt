package ai.openclaw.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayTalkSetupReadinessTest {
  @Test
  fun catalogConfiguredProvidersDriveSetupRows() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog =
          jsonObject(
            """
            {
              "realtime": {
                "activeProvider": "openai-realtime",
                "providers": [
                  {"id":"openai-realtime","label":"OpenAI Realtime","configured":true}
                ]
              },
              "transcription": {
                "activeProvider": "openai-realtime-transcription",
                "providers": [
                  {"id":"openai-realtime-transcription","label":"OpenAI Realtime Transcription","configured":true}
                ]
              }
            }
            """,
          ),
        config = null,
      )

    assertTrue(readiness.realtimeTalk.ready)
    assertEquals("Realtime Talk", readiness.realtimeTalk.title)
    assertEquals("OpenAI Realtime via Gateway relay", readiness.realtimeTalk.subtitle)
    assertEquals("Ready", readiness.realtimeTalk.statusText)
    assertTrue(readiness.dictation.ready)
    assertEquals("Dictation", readiness.dictation.title)
  }

  @Test
  fun catalogUnconfiguredProviderDrivesSetupNeededRows() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog =
          jsonObject(
            """
            {
              "realtime": {
                "providers": [
                  {"id":"openai-realtime","label":"OpenAI Realtime","configured":false}
                ]
              },
              "transcription": {
                "providers": [
                  {"id":"openai-realtime-transcription","label":"OpenAI Realtime Transcription","configured":false}
                ]
              }
            }
            """,
          ),
        config = null,
      )

    assertFalse(readiness.realtimeTalk.ready)
    assertEquals("Needs setup", readiness.realtimeTalk.statusText)
    assertEquals("Configure OpenAI Realtime on the Gateway.", readiness.realtimeTalk.subtitle)
    assertFalse(readiness.dictation.ready)
    assertEquals("Configure OpenAI Realtime Transcription on the Gateway.", readiness.dictation.subtitle)
  }

  @Test
  fun activeUnconfiguredProviderDoesNotFallbackToAnotherConfiguredProvider() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog =
          jsonObject(
            """
            {
              "realtime": {
                "activeProvider": "google-realtime",
                "providers": [
                  {"id":"google-realtime","label":"Google Realtime","configured":false},
                  {"id":"openai-realtime","label":"OpenAI Realtime","configured":true}
                ]
              },
              "transcription": {
                "providers": [
                  {"id":"openai-realtime-transcription","label":"OpenAI Realtime Transcription","configured":true}
                ]
              }
            }
            """,
          ),
        config = null,
      )

    assertFalse(readiness.realtimeTalk.ready)
    assertEquals("google-realtime", readiness.realtimeTalk.providerId)
    assertEquals("Configure Google Realtime on the Gateway.", readiness.realtimeTalk.subtitle)
  }

  @Test
  fun unmatchedRealtimeProviderStaysGatewayVerifiedWhileTranscriptionAliasesResolve() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog =
          jsonObject(
            """
            {
              "realtime": {
                "activeProvider": "openai-realtime",
                "providers": [
                  {"id":"openai","label":"OpenAI Realtime","configured":true}
                ]
              },
              "transcription": {
                "activeProvider": "openai-realtime",
                "providers": [
                  {"id":"openai","label":"OpenAI Realtime Transcription","configured":true}
                ]
              }
            }
            """,
          ),
        config = null,
      )

    assertFalse(readiness.realtimeTalk.ready)
    assertFalse(readiness.realtimeTalk.setupKnown)
    assertEquals("Gateway", readiness.realtimeTalk.statusText)
    assertEquals("openai-realtime", readiness.realtimeTalk.providerId)
    assertEquals("Gateway will verify openai-realtime when you start.", readiness.realtimeTalk.subtitle)
    assertTrue(readiness.dictation.ready)
    assertTrue(readiness.dictation.setupKnown)
    assertEquals("Ready", readiness.dictation.statusText)
    assertEquals("openai", readiness.dictation.providerId)
    assertEquals("OpenAI Realtime Transcription via Gateway relay", readiness.dictation.subtitle)
  }

  @Test
  fun activeProviderAliasMatchesCatalogProviderAlias() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog =
          jsonObject(
            """
            {
              "realtime": {
                "activeProvider": "openai-realtime",
                "providers": [
                  {"id":"openai-realtime","label":"OpenAI Realtime","configured":true}
                ]
              },
              "transcription": {
                "activeProvider": "openai-realtime",
                "providers": [
                  {
                    "id":"openai",
                    "label":"OpenAI Realtime Transcription",
                    "aliases":["openai-realtime"],
                    "configured":true
                  }
                ]
              }
            }
            """,
          ),
        config = null,
      )

    assertTrue(readiness.dictation.ready)
    assertTrue(readiness.dictation.setupKnown)
    assertEquals("openai", readiness.dictation.providerId)
    assertEquals("OpenAI Realtime Transcription via Gateway relay", readiness.dictation.subtitle)
  }

  @Test
  fun activeTranscriptionAliasWithUnconfiguredCanonicalRowStaysGatewayVerified() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog =
          jsonObject(
            """
            {
              "realtime": {
                "activeProvider": "openai-realtime",
                "providers": [
                  {"id":"openai-realtime","label":"OpenAI Realtime","configured":true}
                ]
              },
              "transcription": {
                "activeProvider": "openai-realtime",
                "providers": [
                  {"id":"openai","label":"OpenAI Realtime Transcription","configured":false}
                ]
              }
            }
            """,
          ),
        config = null,
      )

    assertFalse(readiness.dictation.ready)
    assertFalse(readiness.dictation.setupKnown)
    assertEquals("Gateway", readiness.dictation.statusText)
    assertEquals("openai-realtime", readiness.dictation.providerId)
    assertEquals("Gateway will verify openai-realtime when you start.", readiness.dictation.subtitle)
  }

  @Test
  fun missingCatalogLeavesReadinessUnknownInsteadOfConfirmedSetupNeeded() {
    val readiness = parseGatewayTalkSetupReadiness(catalog = null, config = null)

    assertFalse(readiness.realtimeTalk.ready)
    assertFalse(readiness.realtimeTalk.setupKnown)
    assertEquals("Unavailable", readiness.realtimeTalk.statusText)
    assertFalse(readiness.dictation.ready)
    assertFalse(readiness.dictation.setupKnown)
  }

  @Test
  fun emptyProviderCatalogIsKnownUnavailableSetupState() {
    val readiness =
      parseGatewayTalkSetupReadiness(
        catalog =
          jsonObject(
            """
            {
              "realtime": { "providers": [] },
              "transcription": { "providers": [] }
            }
            """,
          ),
        config = null,
      )

    assertFalse(readiness.realtimeTalk.ready)
    assertTrue(readiness.realtimeTalk.setupKnown)
    assertEquals("No Realtime Talk provider is registered on the Gateway.", readiness.realtimeTalk.subtitle)
    assertFalse(readiness.dictation.ready)
    assertTrue(readiness.dictation.setupKnown)
  }

  private fun jsonObject(value: String): JsonObject = Json.parseToJsonElement(value.trimIndent()) as JsonObject
}
