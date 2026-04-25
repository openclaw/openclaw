package ai.openclaw.app

import ai.openclaw.app.node.HttpHandler
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HttpHandlerTest {
  private lateinit var server: MockWebServer
  private lateinit var handler: HttpHandler

  @Before
  fun setUp() {
    server = MockWebServer()
    server.start()
    handler = HttpHandler()
  }

  @After
  fun tearDown() {
    server.shutdown()
  }

  private fun serverUrl(path: String = "/"): String = server.url(path).toString()

  @Test
  fun handles_GET_request_successfully() {
    server.enqueue(
      MockResponse()
        .setResponseCode(200)
        .setBody("""{"success":true}""")
        .setHeader("Content-Type", "application/json")
        .setHeader("X-Custom", "value")
    )

    val result = handler.handleHttpRequest("""{"url":"${serverUrl("api")}","method":"GET"}""")

    assertNotNull(result)
    assertTrue(result.ok)
    assertTrue(result.payloadJson!!.contains("\"status\":200"))
    assertTrue(result.payloadJson!!.contains("\"statusText\":\"OK\""))
    assertTrue(result.payloadJson!!.contains(""""Content-Type":"application/json""""))
    assertTrue(result.payloadJson!!.contains(""""body":"{\"success\":true}""""))
  }

  @Test
  fun rejects_non_http_URLs() {
    val result = handler.handleHttpRequest("""{"url":"ftp://example.com/file"}""")

    assertNotNull(result)
    assertFalse(result.ok)
    assertTrue(result.error!!.message.contains("INVALID_REQUEST"))
    assertTrue(result.error!!.message.contains("http or https"))
  }

  @Test
  fun handles_DNS_error_gracefully() {
    val result = handler.handleHttpRequest("""{"url":"http://nonexistent.invalid/path"}""")

    assertNotNull(result)
    assertFalse(result.ok)
    assertTrue(result.error!!.message.contains("DNS_ERROR"))
  }

  @Test
  fun respects_timeout_parameter() {
    server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))

    val result = handler.handleHttpRequest("""{"url":"${serverUrl("api")}","timeout":5000}""")

    assertNotNull(result)
    assertTrue(result.ok)
  }

  @Test
  fun parses_request_headers_correctly() {
    server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))

    handler.handleHttpRequest(
      """{"url":"${serverUrl("api")}","headers":{"Authorization":"Bearer token","X-Req":"test"}}"""
    )

    val recorded = server.takeRequest()
    assertEquals("Bearer token", recorded.getHeader("Authorization"))
    assertEquals("test", recorded.getHeader("X-Req"))
  }

  @Test
  fun truncates_body_to_MAX_BODY_SIZE_BYTES() {
    val largeBody = "x".repeat(6 * 1024 * 1024)
    server.enqueue(MockResponse().setResponseCode(200).setBody(largeBody))

    val result = handler.handleHttpRequest("""{"url":"${serverUrl("large")}"}""")

    assertNotNull(result)
    assertTrue(result.ok)
    val payload = result.payloadJson!!
    val bodyStart = payload.indexOf("\"body\":\"")
    assertTrue(bodyStart >= 0)
    val bodyContentStart = bodyStart + "\"body\":\"".length
    val bodyContentEnd = payload.indexOf("\"", bodyContentStart)
    val bodyContent = payload.substring(bodyContentStart, bodyContentEnd)
    assertTrue(bodyContent.length <= 5 * 1024 * 1024)
  }

  @Test
  fun supports_POST_with_body() {
    server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":123}"""))

    val result = handler.handleHttpRequest(
      """{"url":"${serverUrl("api")}","method":"POST","body":"{\"name\":\"test\"}"}"""
    )

    assertNotNull(result)
    assertTrue(result.ok)
    assertTrue(result.payloadJson!!.contains("\"status\":201"))

    val recorded = server.takeRequest()
    assertEquals("POST", recorded.method)
    val body = recorded.body.readUtf8()
    assertTrue(body.contains("\"name\":\"test\""))
  }

  @Test
  fun returns_error_response_for_404() {
    server.enqueue(MockResponse().setResponseCode(404).setBody("Not Found"))

    val result = handler.handleHttpRequest("""{"url":"${serverUrl("missing")}"}""")

    assertNotNull(result)
    assertTrue(result.ok)
    assertTrue(result.payloadJson!!.contains("\"status\":404"))
    assertTrue(result.payloadJson!!.contains("\"ok\":false"))
    assertTrue(result.payloadJson!!.contains(""""body":"Not Found""""))
  }
}
