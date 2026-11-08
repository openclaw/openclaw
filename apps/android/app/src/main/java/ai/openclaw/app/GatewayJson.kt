package ai.openclaw.app

import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

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

internal inline fun <T : Any> JsonArray?.mapObjects(transform: (JsonObject) -> T?): List<T> = this?.mapNotNull { item -> item.asObjectOrNull()?.let(transform) }.orEmpty()
