package ai.openclaw.app.chat

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Selection metadata from the Browser plugin, never a URL-derived browser or access grant. */
data class ChatBrowserTab(
  val target: String,
  val node: String?,
  val profile: String,
  val targetId: String,
  val url: String?,
  val title: String?,
)

internal fun parseChatBrowserTab(details: JsonElement?): ChatBrowserTab? {
  val tab = (details as? JsonObject)?.get("browserTab") as? JsonObject ?: return null

  fun string(key: String): String? = (tab[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

  fun identifier(
    key: String,
    limit: Int = 128,
  ): String? = string(key)?.takeIf { it.isNotEmpty() && it.length <= limit && it.trim() == it }
  val targetId = identifier("targetId") ?: return null
  val profile = identifier("profile") ?: return null
  val target = string("target") ?: return null
  val node = identifier("node", 256)
  if (target != "host" && target != "node") return null
  if ((target == "host" && "node" in tab) || (target == "node" && node == null)) return null
  return ChatBrowserTab(
    target = target,
    node = node,
    profile = profile,
    targetId = targetId,
    url = string("url")?.take(2_048),
    title = string("title")?.take(512),
  )
}
