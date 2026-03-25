package ai.openclaw.app.node

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsManagerTest {
  private val json = SmsManager.JsonConfig

  @Test
  fun parseParamsRejectsEmptyPayload() {
    val result = SmsManager.parseParams("", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: paramsJSON required", error.error)
  }

  @Test
  fun parseParamsRejectsInvalidJson() {
    val result = SmsManager.parseParams("not-json", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: expected JSON object", error.error)
  }

  @Test
  fun parseParamsRejectsNonObjectJson() {
    val result = SmsManager.parseParams("[]", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: expected JSON object", error.error)
  }

  @Test
  fun parseParamsRejectsMissingTo() {
    val result = SmsManager.parseParams("{\"message\":\"Hi\"}", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: 'to' phone number required", error.error)
    assertEquals("Hi", error.message)
  }

  @Test
  fun parseParamsRejectsMissingMessage() {
    val result = SmsManager.parseParams("{\"to\":\"+1234\"}", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: 'message' text required", error.error)
    assertEquals("+1234", error.to)
  }

  @Test
  fun parseParamsTrimsToField() {
    val result = SmsManager.parseParams("{\"to\":\"  +1555  \",\"message\":\"Hello\"}", json)
    assertTrue(result is SmsManager.ParseResult.Ok)
    val ok = result as SmsManager.ParseResult.Ok
    assertEquals("+1555", ok.params.to)
    assertEquals("Hello", ok.params.message)
  }

  @Test
  fun buildPayloadJsonEscapesFields() {
    val payload = SmsManager.buildPayloadJson(
      json = json,
      ok = false,
      to = "+1\"23",
      error = "SMS_SEND_FAILED: \"nope\"",
    )
    val parsed = json.parseToJsonElement(payload).jsonObject
    assertEquals("false", parsed["ok"]?.jsonPrimitive?.content)
    assertEquals("+1\"23", parsed["to"]?.jsonPrimitive?.content)
    assertEquals("SMS_SEND_FAILED: \"nope\"", parsed["error"]?.jsonPrimitive?.content)
  }

  @Test
  fun buildSendPlanUsesMultipartWhenMultipleParts() {
    val plan = SmsManager.buildSendPlan("hello") { listOf("a", "b") }
    assertTrue(plan.useMultipart)
    assertEquals(listOf("a", "b"), plan.parts)
  }

  @Test
  fun buildSendPlanFallsBackToSinglePartWhenDividerEmpty() {
    val plan = SmsManager.buildSendPlan("hello") { emptyList() }
    assertFalse(plan.useMultipart)
    assertEquals(listOf("hello"), plan.parts)
  }

  @Test
  fun parseQueryParamsAcceptsEmptyPayload() {
    val result = SmsManager.parseQueryParams(null, json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(25, ok.params.limit)
    assertEquals(0, ok.params.offset)
  }

  @Test
  fun parseQueryParamsRejectsInvalidJson() {
    val result = SmsManager.parseQueryParams("not-json", json)
    assertTrue(result is SmsManager.QueryParseResult.Error)
    val error = result as SmsManager.QueryParseResult.Error
    assertEquals("INVALID_REQUEST: expected JSON object", error.error)
  }

  @Test
  fun parseQueryParamsRejectsNonObjectJson() {
    val result = SmsManager.parseQueryParams("[]", json)
    assertTrue(result is SmsManager.QueryParseResult.Error)
    val error = result as SmsManager.QueryParseResult.Error
    assertEquals("INVALID_REQUEST: expected JSON object", error.error)
  }

  @Test
  fun parseQueryParamsParsesLimitAndOffset() {
    val result = SmsManager.parseQueryParams("{\"limit\":10,\"offset\":5}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(10, ok.params.limit)
    assertEquals(5, ok.params.offset)
  }

  @Test
  fun parseQueryParamsClampsLimitRange() {
    val result = SmsManager.parseQueryParams("{\"limit\":300}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(200, ok.params.limit)
  }

  @Test
  fun parseQueryParamsParsesPhoneNumber() {
    val result = SmsManager.parseQueryParams("{\"phoneNumber\":\"+1234567890\"}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals("+1234567890", ok.params.phoneNumber)
  }

  @Test
  fun parseQueryParamsParsesContactName() {
    val result = SmsManager.parseQueryParams("{\"contactName\":\"lixuankai\"}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals("lixuankai", ok.params.contactName)
  }

  @Test
  fun parseQueryParamsParsesKeyword() {
    val result = SmsManager.parseQueryParams("{\"keyword\":\"test\"}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals("test", ok.params.keyword)
  }

  @Test
  fun parseQueryParamsParsesTimeRange() {
    val result = SmsManager.parseQueryParams("{\"startTime\":1000,\"endTime\":2000}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(1000L, ok.params.startTime)
    assertEquals(2000L, ok.params.endTime)
  }

  @Test
  fun parseQueryParamsParsesType() {
    val result = SmsManager.parseQueryParams("{\"type\":1}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(1, ok.params.type)
  }

  @Test
  fun parseQueryParamsParsesReadStatus() {
    val result = SmsManager.parseQueryParams("{\"isRead\":true}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(true, ok.params.isRead)
  }
}
