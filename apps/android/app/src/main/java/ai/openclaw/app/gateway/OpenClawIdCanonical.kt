package ai.openclaw.app.gateway

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigDecimal

/** RFC 8785 for the protocol's safe-integer JSON subset (not a general floating-point serializer). */
internal object OpenClawIdCanonical {
  const val MAX_SAFE_INTEGER = 9007199254740991L
  val json = Json { isLenient = false }

  // Protocol schemas contain only safe integers, so ECMAScript's numeric spelling is exact here.
  fun encode(value: JsonElement): String =
    when (value) {
      JsonNull -> {
        "null"
      }

      is JsonObject -> {
        value.keys.sorted().joinToString(",", "{", "}") { key ->
          "${string(key)}:${encode(value.getValue(key))}"
        }
      }

      is JsonArray -> {
        value.joinToString(",", "[", "]", transform = ::encode)
      }

      is JsonPrimitive -> {
        when {
          value.isString -> string(value.content)
          value.content == "true" || value.content == "false" -> value.content
          else -> integer(value).toString()
        }
      }
    }

  // Reuse the JSON library for escaping; reject ill-formed UTF-16 before UTF-8 conversion.
  fun string(value: String): String {
    unicode(value)
    return JsonPrimitive(value).toString()
  }

  fun unicode(value: String) {
    var index = 0
    while (index < value.length) {
      val char = value[index++]
      if (char.isHighSurrogate()) {
        require(index < value.length && value[index++].isLowSurrogate()) { "invalid_unicode" }
      } else {
        require(!char.isLowSurrogate()) { "invalid_unicode" }
      }
    }
  }

  fun integer(
    value: JsonElement,
    minimum: Long = 0,
  ): Long {
    require(value is JsonPrimitive && !value.isString) { "invalid_integer" }
    val result =
      try {
        BigDecimal(value.content).longValueExact()
      } catch (_: NumberFormatException) {
        throw IllegalArgumentException("invalid_integer")
      } catch (_: ArithmeticException) {
        throw IllegalArgumentException("invalid_integer")
      }
    require(result in minimum..MAX_SAFE_INTEGER) { "invalid_integer" }
    return result
  }

  fun obj(
    value: JsonElement,
    vararg fields: String,
  ): JsonObject {
    require(value is JsonObject && value.keys == fields.toSet()) { "invalid_fields" }
    return value
  }

  fun text(value: JsonElement): String {
    require(value is JsonPrimitive && value.isString) { "invalid_string" }
    unicode(value.content)
    return value.content
  }
}
