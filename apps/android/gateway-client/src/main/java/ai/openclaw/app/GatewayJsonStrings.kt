package ai.openclaw.app

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

fun JsonElement?.asJsonStringOrNull(): String? =
  (this as? JsonPrimitive)
    ?.takeIf(JsonPrimitive::isString)
    ?.content
