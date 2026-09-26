package ai.openclaw.app.gateway

import ai.openclaw.app.wear.WearChatStreamProjector
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class GatewayLiveTextProjectionTest {
  @Test
  fun chatSnapshotsWinAndAppendsRetainWhitespaceAndCanvasForLateSubscribers() {
    val projection = GatewayLiveTextProjection()
    val baseline =
      chat(
        """"deltaText":"already included","message":{"role":"assistant","timestamp":123,"content":[{"type":"text","text":"Hello ","annotations":[]},{"type":"canvas","id":"canvas-1"},{"type":"image","url":"image.png"},{"type":"thinking","text":"hidden"}]}""",
      )
    assertEquals("Hello ", text(checkNotNull(projection.project("chat", baseline))))
    projection.project("chat", chat(""""deltaText":" """"))
    val latest = checkNotNull(projection.project("chat", chat(""""deltaText":"world\n"""")))
    assertEquals("Hello  world\n", text(latest))
    val message = latest.getValue("message").jsonObject
    assertEquals(JsonPrimitive(123), message["timestamp"])
    assertEquals(
      baseline
        .getValue("message")
        .jsonObject
        .getValue("content")
        .jsonArray
        .drop(1),
      message.getValue("content").jsonArray.drop(1),
    )
    assertEquals(
      "[]",
      message
        .getValue("content")
        .jsonArray
        .first()
        .jsonObject
        .getValue("annotations")
        .toString(),
    )

    // The local consumer may miss all previous updates, including a coalesced wire append.
    val coalesced = "x".repeat(3_000) + "latest tail"
    val afterCoalescing = checkNotNull(projection.project("chat", chat("\"deltaText\":${JsonPrimitive(coalesced)}")))
    assertEquals("Hello  world\n$coalesced", text(afterCoalescing))
    val watch = checkNotNull(WearChatStreamProjector().project(afterCoalescing))
    assertEquals(coalesced.takeLast(2_000), watch.getValue("streamText").jsonPrimitive.content)
    assertEquals(JsonPrimitive(true), watch["streamTextComplete"])
  }

  @Test
  fun replacementsCanClearTextWithoutDroppingMedia() {
    val projection = GatewayLiveTextProjection()
    projection.project("chat", chat(""""message":{"role":"assistant","content":[{"type":"text","text":"old"},{"type":"image","url":"image.png"}]},"deltaText":"old""""))
    val replaced = checkNotNull(projection.project("chat", chat(""""deltaText":"","replace":true""")))
    assertEquals("", text(replaced))
    assertEquals(
      "image",
      replaced
        .getValue("message")
        .jsonObject
        .getValue("content")
        .jsonArray
        .last()
        .jsonObject
        .getValue("type")
        .jsonPrimitive.content,
    )
    assertEquals("new", text(checkNotNull(projection.project("chat", chat(""""deltaText":"new"""")))))
    val fresh = GatewayLiveTextProjection()
    assertEquals("", text(checkNotNull(fresh.project("chat", chat(""""deltaText":"","replace":true""")))))
  }

  @Test
  fun runsSessionsAgentsAndAssistantStreamsNeverShareBaselines() {
    val projection = GatewayLiveTextProjection()
    projection.project("chat", chat(""""message":{"content":[{"type":"text","text":"chat"}]},"deltaText":"chat""""))
    projection.project("agent", agent(""""text":"item","delta":"item","itemId":"a""""))
    assertNull(projection.project("chat", chat(""""deltaText":"suffix"""", session = "other")))
    assertNull(projection.project("chat", chat(""""deltaText":"suffix"""", run = "other")))
    assertNull(projection.project("chat", chat(""""deltaText":"suffix","agentId":"other"""")))
    assertNull(projection.project("agent", JsonObject(agent(""""delta":"suffix","itemId":"a"""") + ("agentId" to JsonPrimitive("other")))))
    assertNull(projection.project("agent", agent(""""delta":"suffix","itemId":"b"""")))
    assertEquals("item tail", assistantText(checkNotNull(projection.project("agent", agent(""""delta":" tail","itemId":"a"""")))))
    assertEquals("chat tail", text(checkNotNull(projection.project("chat", chat(""""deltaText":" tail"""")))))
    assertNull(GatewayLiveTextProjection().project("chat", chat(""""deltaText":"suffix"""")))
    assertNull(GatewayLiveTextProjection().project("agent", agent(""""delta":"suffix"""")))
  }

  @Test
  fun assistantItemSnapshotsRewritesAndToolBarriersPreserveIndependentText() {
    val projection = GatewayLiveTextProjection()
    assertEquals("first ", assistantText(checkNotNull(projection.project("agent", agent(""""text":"first ","delta":"ignored","itemId":"a"""")))))
    val tool = parse("""{"runId":"run","sessionKey":"session","stream":"tool","data":{"phase":"start","toolCallId":"tool-1"}}""")
    assertSame(tool, projection.project("agent", tool))
    assertEquals("first  \n", assistantText(checkNotNull(projection.project("agent", agent(""""delta":" \n","itemId":"a"""")))))
    assertEquals("second", assistantText(checkNotNull(projection.project("agent", agent(""""text":"second","itemId":"b"""")))))
    assertEquals("", assistantText(checkNotNull(projection.project("agent", agent(""""delta":"","replace":true,"itemId":"b"""")))))
    assertEquals("new", assistantText(checkNotNull(projection.project("agent", agent(""""delta":"new","itemId":"b"""")))))
  }

  @Test
  fun chatTerminalsRetireBothStreamsButAgentTerminationKeepsChatBaseline() {
    for (state in listOf("final", "aborted", "error")) {
      val projection = GatewayLiveTextProjection()
      projection.project("chat", chat(""""deltaText":"chat","replace":true"""))
      projection.project("agent", agent(""""text":"item""""))
      val terminal = parse("""{"runId":"run","sessionKey":"session","state":"$state","message":{"role":"assistant","content":[{"type":"text","text":"terminal"}]}}""")
      assertSame(terminal, projection.project("chat", terminal))
      assertNull(projection.project("chat", chat(""""deltaText":"suffix"""")))
      assertNull(projection.project("agent", agent(""""delta":"suffix"""")))
    }
    for (phase in listOf("end", "error")) {
      val projection = GatewayLiveTextProjection()
      projection.project("chat", chat(""""deltaText":"chat","replace":true"""))
      projection.project("agent", agent(""""text":"item""""))
      val terminal = parse("""{"runId":"run","stream":"lifecycle","data":{"phase":"$phase"}}""")
      assertSame(terminal, projection.project("agent", terminal))
      assertNull(projection.project("agent", agent(""""delta":"suffix"""")))
      assertEquals("chat tail", text(checkNotNull(projection.project("chat", chat(""""deltaText":" tail"""")))))
    }
  }

  private fun chat(
    fields: String,
    session: String = "session",
    run: String = "run",
  ): JsonObject = parse("""{"runId":"$run","sessionKey":"$session","state":"delta",$fields}""")

  private fun agent(fields: String): JsonObject = parse("""{"runId":"run","sessionKey":"session","stream":"assistant","data":{$fields}}""")

  private fun text(payload: JsonObject): String =
    payload
      .getValue("message")
      .jsonObject
      .getValue("content")
      .jsonArray
      .first()
      .jsonObject
      .getValue("text")
      .jsonPrimitive.content

  private fun assistantText(payload: JsonObject): String =
    payload
      .getValue("data")
      .jsonObject
      .getValue("text")
      .jsonPrimitive.content

  private fun parse(value: String): JsonObject = Json.parseToJsonElement(value).jsonObject
}
