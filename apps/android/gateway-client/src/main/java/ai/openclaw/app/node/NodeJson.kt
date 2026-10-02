package ai.openclaw.app.node

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

fun JsonElement?.asArrayOrNull(): JsonArray? = this as? JsonArray

/** Converts JSON null to Kotlin null while preserving primitive text content. */
fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.contentOrNull
