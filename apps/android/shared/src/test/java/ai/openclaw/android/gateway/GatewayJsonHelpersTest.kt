package ai.openclaw.android.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayJsonHelpersTest {
  @Test
  fun asStringOrNullReturnsContentForPrimitive() {
    val el: kotlinx.serialization.json.JsonElement = kotlinx.serialization.json.JsonPrimitive("hello")
    assertEquals("hello", el.asStringOrNull())
  }

  @Test
  fun asStringOrNullReturnsNullForJsonNull() {
    val el: kotlinx.serialization.json.JsonElement = kotlinx.serialization.json.JsonNull
    assertNull(el.asStringOrNull())
  }

  @Test
  fun asStringOrNullReturnsNullForNull() {
    val el: kotlinx.serialization.json.JsonElement? = null
    assertNull(el.asStringOrNull())
  }

  @Test
  fun asBooleanOrNullParsesTrueAndFalse() {
    assertEquals(true, kotlinx.serialization.json.JsonPrimitive("true").asBooleanOrNull())
    assertEquals(false, kotlinx.serialization.json.JsonPrimitive("false").asBooleanOrNull())
    assertEquals(true, kotlinx.serialization.json.JsonPrimitive("TRUE").asBooleanOrNull())
    assertNull(kotlinx.serialization.json.JsonPrimitive("maybe").asBooleanOrNull())
  }

  @Test
  fun asLongOrNullParsesNumbers() {
    assertEquals(42L, kotlinx.serialization.json.JsonPrimitive("42").asLongOrNull())
    assertNull(kotlinx.serialization.json.JsonPrimitive("notanumber").asLongOrNull())
  }

  @Test
  fun parseJsonOrNullReturnsNullForBlank() {
    assertNull(parseJsonOrNull(""))
    assertNull(parseJsonOrNull("   "))
  }

  @Test
  fun parseJsonOrNullReturnsElementForValidJson() {
    val el = parseJsonOrNull("""{"key":"value"}""")
    assertTrue(el is kotlinx.serialization.json.JsonObject)
  }

  @Test
  fun parseJsonOrNullReturnsNullForInvalidJson() {
    assertNull(parseJsonOrNull("{invalid"))
  }
}
