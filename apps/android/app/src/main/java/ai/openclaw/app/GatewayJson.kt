package ai.openclaw.app

import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal fun JsonObject?.nonBlankString(key: String): String? =
  this
    ?.get(key)
    .asStringOrNull()
    ?.trim()
    ?.takeIf(String::isNotEmpty)

internal fun JsonObject?.long(key: String): Long? = (this?.get(key) as? JsonPrimitive)?.content?.trim()?.toLongOrNull()
