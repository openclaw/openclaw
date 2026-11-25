package ai.openclaw.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearReplyText
import ai.openclaw.wear.shared.WearReplyTextPage
import ai.openclaw.wear.shared.WearReplyTextStatus
import ai.openclaw.wear.shared.WearRpcMethod
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WearReplyRepositoryTest {
  private val target = WearReplyTarget("phone", "session", "agent", "entry")
  private val full = "👩🏽‍🚀 Grüße".repeat(1000)

  @Test fun requestPinsPreferredPhoneAndValidatesEveryPage() =
    runTest {
      val good = WearReplyText.page(full, "owner", 0, null)
      for (page in listOf(good, good.copy(offset = 1), good.copy(nextOffset = 1), good.copy(totalLength = 1), good.copy(revision = null), good.copy(nextOffset = null))) {
        val repo = repository(page)
        assertEquals(if (page == good) WearReplyTextStatus.Ready else WearReplyTextStatus.Failed, repo.replyText(target, 0, null).status)
      }
      val next = WearReplyText.page(full, "owner", good.nextOffset!!, good.revision)
      assertEquals(WearReplyTextStatus.Ready, repository(next).replyText(target, good.nextOffset!!, good.revision).status)
      assertEquals(WearReplyTextStatus.Failed, repository(next.copy(revision = "other")).replyText(target, good.nextOffset!!, good.revision).status)
      assertEquals(WearReplyTextStatus.Changed, repository(good, "other-phone").replyText(target, 0, null).status)
    }

  private fun repository(
    page: WearReplyTextPage,
    source: String = "phone",
  ) = WearGatewayRepository(
    object : WearRpcRequester {
      override suspend fun request(
        method: WearRpcMethod,
        params: JsonObject,
        expectedNodeId: String?,
        requirePreferredNode: Boolean,
      ): WearRpcResult {
        assertEquals(WearRpcMethod.ReplyText, method)
        assertEquals("phone", expectedNodeId)
        assertTrue(requirePreferredNode)
        val bytes = WearProtocolCodec.encode(WearMessage.Response(requestId = "page", ok = true, result = WearReplyText.encode(page)))
        val decoded = (WearProtocolCodec.decode(bytes) as WearDecodeResult.Success).message as WearMessage.Response
        return WearRpcResult(decoded.result!!, 1, source)
      }
    },
  )
}
