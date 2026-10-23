package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.createChatController
import ai.openclaw.app.gateway.resolveGatewaySourcePreviewConfig
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class ChatSourcePreviewsTest {
  private val original = "https://example.com/guide"
  private val final = "https://example.org/guide"
  private val paragraph = "This recorded page paragraph gives a useful description of the coastal walking trail and its sheltered picnic spots."

  private fun framed(
    text: String,
    tool: String = "web_search",
  ) = "<<<EXTERNAL_UNTRUSTED_CONTENT id=\"0123456789abcdef\">>>\nSource: ${if (tool == "web_fetch") "Web Fetch" else "Web Search"}\n---\n$text\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\"0123456789abcdef\">>>"

  private fun search(
    urls: List<String> = listOf(original),
    kind: String = "results",
  ) = buildJsonObject {
    put("kind", JsonPrimitive(kind))
    put("externalContent", external("web_search"))
    put("text", JsonPrimitive(framed("Combined provider answer must never become a page excerpt.")))
    put(
      if (kind == "results") "results" else "citations",
      JsonArray(
        urls.map { url ->
          buildJsonObject {
            put("url", JsonPrimitive(url))
            put("title", JsonPrimitive(framed("**Coastal guide**")))
            put("snippet", JsonPrimitive(framed("A quiet route beside the inlet.")))
          }
        },
      ),
    )
  }

  private fun fetch(
    requested: String = original,
    destination: String = final,
    text: String = paragraph,
  ) = buildJsonObject {
    put("url", JsonPrimitive(requested))
    put("finalUrl", JsonPrimitive(destination))
    put("status", JsonPrimitive(200))
    put("title", JsonPrimitive(framed("Updated guide", "web_fetch")))
    put("text", JsonPrimitive(framed("# Navigation\n\n$text", "web_fetch") + "\n[truncated] Debug spill path"))
    put("externalContent", external("web_fetch"))
  }

  private fun external(tool: String) =
    buildJsonObject {
      put("source", JsonPrimitive(tool))
      put("wrapped", JsonPrimitive(true))
      put("untrusted", JsonPrimitive(true))
    }

  private fun result(
    payload: JsonObject,
    name: String = "web_search",
    run: String = "run-1",
  ) = buildJsonObject {
    put("role", JsonPrimitive("toolResult"))
    put("runId", JsonPrimitive(run))
    put("toolName", JsonPrimitive(name))
    put("toolCallId", JsonPrimitive("call-1"))
    put("details", payload)
    put("content", JsonPrimitive("Recorded tool output"))
  }

  private fun answer(text: String) =
    buildJsonObject {
      put("role", JsonPrimitive("assistant"))
      put("runId", JsonPrimitive("run-1"))
      put("phase", JsonPrimitive("final_answer"))
      put("content", JsonPrimitive(text))
    }

  private suspend fun TestScope.history(rows: List<JsonObject>): List<ChatMessage> {
    val controller =
      createChatController { method, _ ->
        if (method == "chat.history") buildJsonObject { put("messages", JsonArray(rows)) }.toString() else "{}"
      }
    controller.load("main")
    advanceUntilIdle()
    return controller.messages.value
  }

  private suspend fun TestScope.previews(
    rows: List<JsonObject>,
    text: String = "Read [the guide]($original)",
    context: ChatSourceLinkContext = ChatSourceLinkContext(),
  ): List<ChatSourcePreview> {
    val messages = history(rows + answer(text))
    return extractChatSourcePreviews(messages, messages.last(), context)
  }

  @Test
  fun canonicalHistoryMatchesMarkdownCitationsAndPrefersRecordedPageParagraphs() =
    runTest {
      val sources = previews(listOf(result(search()), result(fetch(), "web_fetch")))
      val source = sources.single()
      assertEquals(final, source.url)
      assertEquals("Updated guide", source.title)
      assertEquals(paragraph, source.excerpt)
      assertTrue(source.pageExcerpt)
      assertEquals(setOf(original, final), source.aliases)

      val markdown = "`[code]($original)`\n\n![image]($original)\n\n```\n[code]($original)\n```"
      assertTrue(previews(listOf(result(search())), markdown).isEmpty())
      assertEquals(1, previews(listOf(result(search())), "[reference][guide]\n\n[guide]: $original").size)
    }

  @Test
  fun onlySuccessfulSameRunConsistentToolEnvelopesSupplySources() =
    runTest {
      val valid = result(search())
      val call =
        buildJsonObject {
          put("role", JsonPrimitive("assistant"))
          put("runId", JsonPrimitive("run-1"))
          put(
            "content",
            JsonArray(
              listOf(
                buildJsonObject {
                  put("type", JsonPrimitive("toolCall"))
                  put("id", JsonPrimitive("call-1"))
                  put("name", JsonPrimitive("exec"))
                },
              ),
            ),
          )
        }
      val invalid =
        listOf(
          listOf(result(search(), run = "other-run")),
          listOf(result(search(), name = "exec")),
          listOf(JsonObject(valid + ("isError" to JsonPrimitive(true)))),
          listOf(call, valid),
          listOf(result(JsonObject(search() - "externalContent"))),
          listOf(JsonObject(valid + ("__openclaw" to buildJsonObject { put("runId", JsonPrimitive("other-run")) }))),
          listOf(JsonObject(valid + ("provenance" to buildJsonObject { put("kind", JsonPrimitive("internal_system")) }))),
        )
      for (rows in invalid) assertTrue(rows.toString(), previews(rows).isEmpty())
      val after = history(listOf(answer("[guide]($original)"), valid))
      assertTrue(extractChatSourcePreviews(after, after.first()).isEmpty())
    }

  @Test
  fun pairedToolUseAliasesRetainCitedSourcesWithoutAnEnvelopeToolName() =
    runTest {
      for ((callType, resultType) in listOf(
        "toolUse" to "toolResult",
        "tooluse" to "tool_result",
        "TOOLUSE" to "TOOL_RESULT",
        "tool_use" to "toolresult",
        "toolCall" to "toolResult",
        "tool_call" to "tool_result",
      )) {
        fun carrier(block: JsonObject) =
          buildJsonObject {
            put("role", JsonPrimitive("assistant"))
            put("runId", JsonPrimitive("run-1"))
            put("content", JsonArray(listOf(block)))
          }
        val call =
          carrier(
            buildJsonObject {
              put("type", JsonPrimitive(callType))
              put("id", JsonPrimitive("paired-search"))
              put("name", JsonPrimitive("web_search"))
            },
          )
        val result =
          carrier(
            buildJsonObject {
              put("type", JsonPrimitive(resultType))
              put("toolUseId", JsonPrimitive("paired-search"))
              put("name", JsonPrimitive("web_search"))
              put("details", search())
              put("content", JsonPrimitive("Recorded search result"))
            },
          )
        val messages = history(listOf(call, result, answer("[guide]($original)")))
        assertEquals("$callType/$resultType", 1, extractChatSourcePreviews(messages, messages.last()).size)
        assertEquals(
          "toolCall",
          messages
            .first()
            .content
            .single()
            .type,
        )
        assertEquals(
          "web_search",
          messages
            .first()
            .content
            .single()
            .toolActivity
            ?.name,
        )
      }
    }

  @Test
  fun canonicalToolRoleAliasesRenderAndRetainSourceEvidence() =
    runTest {
      for (role in listOf("toolResult", "tool", "tool_result", " TOOL_RESULT ")) {
        val row = JsonObject(result(search()) + ("role" to JsonPrimitive(role)))
        val messages = history(listOf(row, answer("[guide]($original)")))
        assertEquals("role=$role", "toolresult", messages.first().role)
        assertEquals(
          "role=$role",
          "web_search",
          messages
            .first()
            .content
            .single()
            .toolActivity
            ?.name,
        )
        assertEquals("role=$role", 1, extractChatSourcePreviews(messages, messages.last()).size)
      }
    }

  @Test
  fun failedStandaloneAndInlineAliasesKeepErrorDisplayWithoutSources() =
    runTest {
      for (errorKey in listOf("isError", "is_error")) {
        val failed = JsonObject(result(search()) + (errorKey to JsonPrimitive(true)))
        val inline =
          buildJsonObject {
            put("role", JsonPrimitive("assistant"))
            put("runId", JsonPrimitive("run-1"))
            put("toolName", JsonPrimitive("web_search"))
            put("content", JsonArray(listOf(JsonObject(failed - "role" + ("type" to JsonPrimitive("tool_result"))))))
          }
        for (row in listOf(failed, inline)) {
          val messages = history(listOf(row, answer("[guide]($original)")))
          assertEquals(
            "$errorKey: $row",
            true,
            messages
              .first()
              .content
              .single()
              .toolActivity
              ?.isError,
          )
          assertTrue("$errorKey: $row", extractChatSourcePreviews(messages, messages.last()).isEmpty())
        }
      }
      for (flag in listOf(JsonPrimitive(false), JsonPrimitive("true"), JsonPrimitive(1))) {
        val row = JsonObject(result(search()) + ("is_error" to flag))
        assertEquals("Only boolean true means failure", 1, previews(listOf(row)).size)
      }
      val explicitSuccess = JsonObject(result(search()) + mapOf("isError" to JsonPrimitive(false), "is_error" to JsonPrimitive(true)))
      assertEquals("Canonical boolean isError takes precedence", 1, previews(listOf(explicitSuccess)).size)
    }

  @Test
  fun answerCitationsHaveNoInventedExcerptAndUnframedFieldsAreUnavailable() =
    runTest {
      val citation = previews(listOf(result(search(kind = "answer")))).single()
      assertNull(citation.excerpt)
      val unframed =
        JsonObject(
          search() + (
            "results" to
              JsonArray(
                listOf(
                  buildJsonObject {
                    put("url", JsonPrimitive(original))
                    put("title", JsonPrimitive("Unwrapped title"))
                    put("snippet", JsonPrimitive("Unwrapped snippet"))
                  },
                ),
              )
          ),
        )
      val unavailable = previews(listOf(result(unframed))).single()
      assertEquals("example.com", unavailable.title)
      assertNull(unavailable.excerpt)
      val snippet = previews(listOf(result(search()), result(fetch(text = "Navigation only"), "web_fetch"))).single()
      assertEquals("A quiet route beside the inlet.", snippet.excerpt)
      assertEquals(false, snippet.pageExcerpt)
    }

  @Test
  fun redirectRefreshesFollowTheLatestObservedDestinationAndCanReturnToOriginal() =
    runTest {
      val refreshed = "The later recorded paragraph replaces stale page content while retaining the citation to the original requested address."
      val rows = listOf(result(search()), result(fetch(), "web_fetch"), result(fetch(final, final, refreshed), "web_fetch"))
      assertEquals(refreshed, previews(rows).single().excerpt)
      val returned = previews(rows + result(fetch(original, original, paragraph), "web_fetch"))
      assertEquals(original, returned.single().url)
      assertEquals(paragraph, returned.single().excerpt)
    }

  @Test
  fun encodedConfiguredAndNativeMountsExcludeTheirCitedSessionLinks() =
    runTest {
      for ((configuredPath, nativePath, encodedPath) in listOf(
        Triple("/team space", "/socket", "/team%20space"),
        Triple("/知识", "/socket", "/%E7%9F%A5%E8%AF%86"),
        Triple("/team%20space", "/socket", "/team%20space"),
        Triple("", "/team%20space", "/team%20space"),
      )) {
        val config =
          checkNotNull(
            resolveGatewaySourcePreviewConfig(
              buildJsonObject {
                put(
                  "gateway",
                  buildJsonObject {
                    put("controlUi", buildJsonObject { put("basePath", JsonPrimitive(configuredPath)) })
                  },
                )
              },
              "https://gateway.example$nativePath",
              1L,
            ),
          )
        val session = "https://gateway.example$encodedPath/chat/main/research"
        val sources =
          previews(
            listOf(result(search(listOf(session, original)))),
            "[session]($session) [guide]($original)",
            ChatSourceLinkContext(config.gatewayUrl, config.basePath, config.publicOrigin),
          )
        assertEquals("configured=$configuredPath native=$nativePath", listOf(original), sources.map { it.url })
        assertEquals(encodedPath, config.basePath)
      }
    }

  @Test
  fun dedicatedLinksAndUnsafeUrlsDoNotConsumeTheEightSourceSlots() =
    runTest {
      val issue = "https://github.com/openclaw/openclaw/issues/123"
      val session = "https://gateway.example/app/chat/main/session"
      val redirect = "https://example.net/redirect"
      val ordinary = listOf("https://github.com/openclaw/openclaw", "https://outside.example/chat/main") + (1..8).map { "https://example.com/source-$it" }
      val urls = listOf(issue, session, redirect, "https://user:password@example.com/guide", "javascript:alert(1)") + ordinary
      val result =
        previews(
          listOf(result(search(urls)), result(fetch(redirect, issue), "web_fetch")),
          urls.joinToString("\n") { "[source]($it)" },
          ChatSourceLinkContext("https://gateway.example", "/app"),
        )
      assertEquals(ordinary.take(8), result.map { it.url })
      assertEquals(8, result.size)
    }
}
