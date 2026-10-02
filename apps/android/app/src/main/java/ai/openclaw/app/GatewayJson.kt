package ai.openclaw.app

import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal fun JsonElement?.asJsonStringOrNull(): String? =
  (this as? JsonPrimitive)
    ?.takeIf(JsonPrimitive::isString)
    ?.content

internal fun JsonObject?.nonBlankString(key: String): String? =
  this
    ?.get(key)
    .asStringOrNull()
    ?.trim()
    ?.takeIf(String::isNotEmpty)

internal fun JsonObject?.long(key: String): Long? = (this?.get(key) as? JsonPrimitive)?.content?.trim()?.toLongOrNull()
