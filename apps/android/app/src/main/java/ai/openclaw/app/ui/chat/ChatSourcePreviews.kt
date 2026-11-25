package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatRecordedSource
import ai.openclaw.app.takeUtf16Safe
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.commonmark.node.Code
import org.commonmark.node.Document
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.Text

internal data class ChatSourcePreview(
  val url: String,
  val title: String,
  val domain: String,
  val excerpt: String?,
  val pageExcerpt: Boolean,
  val aliases: Set<String>,
)

internal data class ChatSourceLinkContext(
  val gatewayUrl: String? = null,
  val basePath: String = "",
  val publicOrigin: String? = null,
)

private data class SourceCandidates(
  var source: ChatRecordedSource,
  var page: ChatRecordedSource? = null,
  var search: ChatRecordedSource? = null,
)

internal fun chatSourceUrl(value: String?): HttpUrl? =
  value
    ?.takeIf { it.length <= 2_048 && (it.startsWith("https://", true) || it.startsWith("http://", true)) }
    ?.toHttpUrlOrNull()
    ?.takeIf { it.username.isEmpty() && it.password.isEmpty() }

internal fun chatSourceKey(value: String): String? =
  chatSourceUrl(value)
    ?.newBuilder()
    ?.fragment(null)
    ?.build()
    ?.toString()

/** Matches recorded, normalized web evidence to citations in one completed answer. */
internal fun extractChatSourcePreviews(
  messages: List<ChatMessage>,
  answer: ChatMessage,
  context: ChatSourceLinkContext = ChatSourceLinkContext(),
): List<ChatSourcePreview> {
  val run = answer.runId?.takeIf(String::isNotBlank) ?: return emptyList()
  if (answer.role != "assistant" || answer.phase == "commentary" || answer.isError || answer.isSyntheticDisplay || answer.provenance != null) return emptyList()
  val answerIndex = messages.indexOfFirst { it === answer }
  if (answerIndex < 0) return emptyList()
  val text =
    answer.content
      .filter { it.type == "text" }
      .mapNotNull { it.text }
      .joinToString("\n")
  if (text.isBlank() || text.length > 30_000) return emptyList()
  val links = markdownSourceLinks(text)
  if (links.isEmpty()) return emptyList()
  val cited = links.toMutableSet()
  val sources = mutableMapOf<String, SourceCandidates>()
  val redirects = mutableMapOf<String, String>()
  val calls = mutableMapOf<String, String>()
  for (message in messages.take(answerIndex)) {
    if (message.runId != run || message.role !in setOf("assistant", "toolresult") || message.isSyntheticDisplay || message.provenance != null || message.isError) continue
    if (message.sourceTools.any { it.runId != null && it.runId != run }) continue
    for (tool in message.sourceTools) {
      if (!tool.isResult) {
        if (tool.callId != null && tool.name != null) calls[tool.callId] = tool.name
        continue
      }
      if (tool.isError || !tool.completed) continue
      val name = tool.callId?.let(calls::get) ?: tool.envelopeName
      if (name !in setOf("web_search", "web_fetch") || (tool.name != null && tool.name != name) || (tool.envelopeName != null && tool.envelopeName != name)) continue
      for (source in tool.sources) {
        if (source.toolName != name) continue
        val url = chatSourceUrl(source.url) ?: continue
        val key = checkNotNull(chatSourceKey(url.toString()))
        val requestedKey = chatSourceKey(source.requestedUrl) ?: continue
        val keys = setOf(key, requestedKey)
        if (keys.none(cited::contains)) continue
        val candidates = sources.getOrPut(key) { SourceCandidates(source) }
        if (name == "web_fetch") {
          candidates.source = source
          candidates.page = source
          candidates.search = candidates.search ?: keys.firstNotNullOfOrNull { sources[it]?.search }
          cited.add(key)
          keys.filter { it != key }.forEach { redirects[it] = key }
          redirects.remove(key)
        } else if (candidates.search?.prose == null) {
          candidates.search = source
          if (candidates.page == null) candidates.source = source
        }
      }
    }
  }

  fun destination(link: String): String {
    var key = link
    val visited = mutableSetOf<String>()
    while (visited.add(key)) key = redirects[key] ?: break
    return key
  }
  val previews = linkedMapOf<String, ChatSourcePreview>()
  for (link in links) {
    if (hasDedicatedSourcePresentation(link, context)) continue
    val key = destination(link)
    val candidate = sources[key] ?: continue
    if (hasDedicatedSourcePresentation(key, context) || previews.containsKey(key)) continue
    val source = candidate.source
    val url = chatSourceUrl(source.url) ?: continue
    val pageExcerpt = candidate.page?.prose?.let { sourceExcerpt(it, page = true) }
    previews[key] =
      ChatSourcePreview(
        url = url.toString(),
        title = source.title?.let(::sourceTitle)?.takeIf(String::isNotEmpty) ?: url.host,
        domain = url.host,
        excerpt = pageExcerpt ?: candidate.search?.prose?.let { sourceExcerpt(it, page = false) },
        pageExcerpt = pageExcerpt != null,
        aliases = (redirects.keys + links + key).filter { destination(it) == key }.toSet(),
      )
    if (previews.size == 8) break
  }
  return previews.values.toList()
}

private fun markdownSourceLinks(text: String): List<String> =
  buildList {
    fun walk(start: Node?) {
      for (node in markdownSiblings(start)) {
        when (node) {
          is Link -> node.destination?.let(::chatSourceKey)?.let(::add)
          is Code, is FencedCodeBlock, is IndentedCodeBlock, is Image -> Unit
          else -> walk(node.firstChild)
        }
      }
    }
    walk(parseChatMarkdown(text).firstChild)
  }

private fun inlineSourceText(start: Node?): String =
  buildString {
    fun walk(start: Node?) {
      for (node in markdownSiblings(start)) {
        when (node) {
          is Text -> append(node.literal)
          is Code -> append(node.literal)
          is SoftLineBreak, is HardLineBreak -> append(' ')
          is Image, is FencedCodeBlock, is IndentedCodeBlock -> Unit
          else -> walk(node.firstChild)
        }
      }
    }
    walk(start)
  }.replace(Regex("\\s+"), " ").trim()

private fun sourceTitle(prose: String): String =
  markdownSiblings(parseChatMarkdown(prose).firstChild)
    .map { inlineSourceText(it.firstChild) }
    .filter(String::isNotEmpty)
    .joinToString(" ")
    .takeUtf16Safe(180)

private fun sourceExcerpt(
  prose: String,
  page: Boolean,
): String? {
  fun find(start: Node?): String? {
    for (node in markdownSiblings(start)) {
      if (node is Paragraph && (!page || node.parent is Document)) {
        val text = inlineSourceText(node.firstChild)
        if (text.length >= if (page) 60 else 1) return if (text.length > 280) text.takeUtf16Safe(279).trimEnd() + "…" else text
      }
      if (!page) find(node.firstChild)?.let { return it }
    }
    return null
  }
  return find(parseChatMarkdown(prose).firstChild)
}

private fun hasDedicatedSourcePresentation(
  value: String,
  context: ChatSourceLinkContext,
): Boolean {
  val url = chatSourceUrl(value) ?: return false
  val parts = url.encodedPath.split('/').filter(String::isNotEmpty)
  if (url.scheme == "https" && url.host == "github.com" && url.port == 443 && parts.size >= 4 &&
    parts[2] in setOf("issues", "pull") && Regex("[1-9][0-9]{0,9}").matches(parts[3])
  ) {
    return true
  }
  val local =
    listOfNotNull(context.gatewayUrl, context.publicOrigin).mapNotNull(::chatSourceUrl).any {
      it.scheme == url.scheme && it.host == url.host && it.port == url.port
    }
  if (!local) return false
  val prefix = context.basePath.trimEnd('/')
  val path = url.encodedPath.trimEnd('/')
  val route = listOf("chat", "dashboard").firstOrNull { path.startsWith("$prefix/$it/") } ?: return false
  val segments = path.removePrefix("$prefix/$route/").split('/')
  return segments.all(String::isNotBlank) && (segments.getOrNull(1) != "~key" || segments.size > 2)
}
