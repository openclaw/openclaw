package ai.openclaw.app

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

internal fun JsonElement?.asArrayOrNull(): JsonArray? = this as? JsonArray

/** Converts JSON null to Kotlin null while preserving primitive text content. */
fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.contentOrNull

internal fun JsonElement?.asJsonStringOrNull(): String? =
  (this as? JsonPrimitive)
    ?.takeIf(JsonPrimitive::isString)
    ?.content

internal fun JsonElement?.asLongOrNull(): Long? = (this as? JsonPrimitive)?.content?.toLongOrNull()

internal fun JsonElement?.asBooleanOrNull(): Boolean? = (this as? JsonPrimitive)?.content?.toBooleanStrictOrNull()

internal fun JsonObject?.nonBlankString(key: String): String? =
  this
    ?.get(key)
    .asStringOrNull()
    ?.trim()
    ?.takeIf(String::isNotEmpty)

internal fun JsonObject?.long(key: String): Long? = (this?.get(key) as? JsonPrimitive)?.content?.trim()?.toLongOrNull()

internal fun JsonObject?.boolean(key: String): Boolean = (this?.get(key) as? JsonPrimitive)?.content?.trim() == "true"

internal inline fun <T : Any> JsonArray?.mapObjects(transform: (JsonObject) -> T?): List<T> = this?.mapNotNull { item -> item.asObjectOrNull()?.let(transform) }.orEmpty()
