package ai.openclaw.app.voice

import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class TalkSpeakClientTest {
  @Test
  fun serializesParsedDirectiveWithStableBytesAndOmitsOnce() =
    runTest {
      var request: Triple<String, String, Long>? = null
      val client =
        TalkSpeakClient(
          requestDetailed = { method, paramsJson, timeoutMs ->
            request = Triple(method, paramsJson, timeoutMs)
            GatewaySession.RpcResult(ok = false, payloadJson = null, error = null)
          },
        )
      val parsed =
        TalkDirectiveParser.parse(
          """
          {"voice":"v","model":"m","output_format":"pcm","speed":1.25,"rate":0,"stability":0.0,"similarity":0.4,"style":0.0,"speaker_boost":false,"seed":42,"normalize":"auto","lang":"en","latency":0,"once":true}
          Say "hello".
          """.trimIndent(),
        )

      client.synthesize(text = parsed.stripped, directive = parsed.directive)

      val expectedJson =
        """{"text":"Say \"hello\".","voiceId":"v","modelId":"m","outputFormat":"pcm","speed":1.25,"rateWpm":0,"stability":0.0,"similarity":0.4,"style":0.0,"speakerBoost":false,"seed":42,"normalize":"auto","language":"en","latencyTier":0}"""
      assertEquals(Triple("talk.speak", expectedJson, 45_000L), request)

      for (directive in listOf(null, TalkDirective(once = true))) {
        client.synthesize(text = "Hello", directive = directive)
        assertEquals(Triple("talk.speak", """{"text":"Hello"}""", 45_000L), request)
      }
    }

  @Test
  fun fallsBackOnlyForUnavailableReasons() =
    runTest {
      val client =
        TalkSpeakClient(
          requestDetailed = { _, _, _ ->
            GatewaySession.RpcResult(
              ok = false,
              payloadJson = null,
              error =
                GatewaySession.ErrorShape(
                  code = "UNAVAILABLE",
                  message = "talk unavailable",
                  details =
                    GatewayErrorDetails(
                      code = null,
                      canRetryWithDeviceToken = false,
                      recommendedNextStep = null,
                      reason = "talk_unconfigured",
                    ),
                ),
            )
          },
        )

      val result = client.synthesize(text = "Hello", directive = null)
      assertTrue(result is TalkSpeakResult.FallbackToLocal)
    }

  @Test
  fun doesNotFallBackForSynthesisFailure() =
    runTest {
      val client =
        TalkSpeakClient(
          requestDetailed = { _, _, _ ->
            GatewaySession.RpcResult(
              ok = false,
              payloadJson = null,
              error =
                GatewaySession.ErrorShape(
                  code = "UNAVAILABLE",
                  message = "provider failed",
                  details =
                    GatewayErrorDetails(
                      code = null,
                      canRetryWithDeviceToken = false,
                      recommendedNextStep = null,
                      reason = "synthesis_failed",
                    ),
                ),
            )
          },
        )

      val result = client.synthesize(text = "Hello", directive = null)
      assertTrue(result is TalkSpeakResult.Failure)
    }

  @Test
  fun fallsBackWhenGatewayOmitsReason() =
    runTest {
      val client =
        TalkSpeakClient(
          requestDetailed = { _, _, _ ->
            GatewaySession.RpcResult(
              ok = false,
              payloadJson = null,
              error =
                GatewaySession.ErrorShape(
                  code = "INVALID_REQUEST",
                  message = "unknown method: talk.speak",
                  details = null,
                ),
            )
          },
        )

      val result = client.synthesize(text = "Hello", directive = null)
      assertTrue(result is TalkSpeakResult.FallbackToLocal)
    }

  @Test
  fun propagatesRequestCancellation() =
    runTest {
      val client =
        TalkSpeakClient(
          requestDetailed = { _, _, _ -> throw CancellationException("talk stopped") },
        )

      try {
        client.synthesize(text = "Hello", directive = null)
        fail("expected cancellation to propagate")
      } catch (err: CancellationException) {
        assertEquals("talk stopped", err.message)
      }
    }
}
