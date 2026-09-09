package ai.openclaw.app

import ai.openclaw.app.chat.AndroidClientDatabases
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatOutboxEnqueueResult
import ai.openclaw.app.chat.ChatOutboxStatus
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatQuestionStatus
import ai.openclaw.app.gateway.QuestionListResult
import ai.openclaw.app.gateway.QuestionRecord
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import androidx.room3.RoomDatabase
import androidx.room3.useReaderConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.util.ReflectionHelpers
import java.time.Duration
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], instrumentedPackages = ["ai.openclaw.app.AndroidScreenshotFixture"])
@LooperMode(LooperMode.Mode.PAUSED)
class AndroidScreenshotFixtureRuntimeTest {
  @After
  fun restoreScene() {
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
  }

  @Test
  fun branchesIntentLoadsCanonicalBranchesThroughTheRuntime() {
    val scene =
      checkNotNull(
        parseAndroidScreenshotModeIntent(
          Intent(Intent.ACTION_MAIN)
            .putExtra(extraAndroidScreenshotMode, true)
            .putExtra(extraAndroidScreenshotScene, "branches"),
        ),
      )
    AndroidScreenshotFixture.configure(scene)
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs = SecurePrefs(app, app.getSharedPreferences("branch-screenshot-test", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val store = ViewModelStore()
    bindNodeRuntimeTestFixture(app, runtime)
    try {
      val model = MainViewModel(app, prefs, SavedStateHandle())
      store.put("branches", model)
      model.enterScreenshotFixtureMode(scene)
      model.loadCurrentChat()
      drainWithMainLooper {
        withTimeout(5_000) {
          model.chatMessages.first { it.isNotEmpty() }
          model.chatHealthOk.first { it }
          runtime.chatOutboxPresentationRestored.first { it }
          model.refreshChatSessionBranches()
          assertEquals("The branches intent must expose canonical branch choices", 12, runtime.chatSessionBranches.value.size)
          assertEquals(AndroidScreenshotScene.Branches, scene)
          assertEquals(HomeDestination.Chat, model.requestedHomeDestination.value)
          assertEquals(AndroidScreenshotFixture.mainSessionKey, runtime.chatSessionKey.value)
          assertEquals("main", runtime.chatSessionOwnerAgentId.value)
          assertEquals(0, runtime.pendingRunCount.value)
          val methods = ReflectionHelpers.getField<Set<String>>(runtime, "gatewayAdvertisedMethods")
          assertTrue(methods.containsAll(listOf("sessions.branches.list", "sessions.branches.switch")))
          val request = runtimeRequester(runtime)

          val before = runtime.chatMessages.value
          val branches = runtime.chatSessionBranches.value
          assertEquals(12, branches.map { it.leafEntryId }.toSet().size)
          assertEquals(before.last().entryId, branches.single { it.active }.leafEntryId)
          branches.forEach {
            assertTrue(it.headline.isNotBlank())
            assertEquals(before.size, it.messageCount)
            assertTrue(Instant.parse(it.updatedAt).toEpochMilli() > 0)
          }
          val selected = branches[7]
          assertTrue("The unchanged controller must complete a real fixture switch", model.switchChatSessionBranch(selected.leafEntryId))
          assertEquals(
            selected.leafEntryId,
            runtime.chatSessionBranches.value
              .single { it.active }
              .leafEntryId,
          )
          assertEquals(
            selected.leafEntryId,
            runtime.chatMessages.value
              .last()
              .entryId,
          )
          assertEquals(
            before.first().content,
            runtime.chatMessages.value
              .first()
              .content,
          )
          assertEquals(
            before.first().entryId,
            runtime.chatMessages.value
              .first()
              .entryId,
          )
          assertNotEquals(
            before.last().content,
            runtime.chatMessages.value
              .last()
              .content,
          )
          model.chatMessages.first { it.lastOrNull()?.entryId == selected.leafEntryId }

          model.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
          assertSame(runtime, app.ensureScreenshotFixtureRuntime())
          assertSame("Reentry must not replace the requester", request, runtimeRequester(runtime))
          assertEquals(
            selected.leafEntryId,
            runtime.chatSessionBranches.value
              .single { it.active }
              .leafEntryId,
          )
          assertEquals(
            selected.leafEntryId,
            runtime.chatMessages.value
              .last()
              .entryId,
          )
          val retainedHistory = response(request, "chat.history", branchParams())
          val retainedTip =
            retainedHistory
              .getValue("messages")
              .jsonArray
              .last()
              .jsonObject["__openclaw"]
              ?.jsonObject
              ?.get("id")
              ?.jsonPrimitive
              ?.content
          val advertised = ReflectionHelpers.getField<Set<String>>(runtime, "gatewayAdvertisedMethods")
          val advertises = runtimeMethodPredicate(runtime)
          assertEquals(
            "Reentry must retain branch data and both predicates consistent with the published catalogue",
            listOf(selected.leafEntryId, true, true, true, true),
            listOf(
              retainedTip,
              advertises("sessions.branches.list"),
              advertises("sessions.branches.switch"),
              "sessions.branches.list" in advertised,
              "sessions.branches.switch" in advertised,
            ),
          )
          assertFalse(retainedHistory.containsKey("inFlightRun"))

          val runtimeJob = checkNotNull(ReflectionHelpers.getField<CoroutineScope>(runtime, "scope").coroutineContext[Job])
          val priorJobs = runtimeJob.children.toSet()
          model.refreshChat()
          // History is published before branch reconciliation; await the finite refresh work, not only that publication.
          runtimeJob.children
            .filterNot { it in priorJobs }
            .toList()
            .joinAll()
          runtime.chatHistoryLoading.first { !it }
          assertTrue(model.refreshChatSessionBranches())
          assertEquals(
            selected.leafEntryId,
            runtime.chatMessages.value
              .last()
              .entryId,
          )
          val retainedSelection = branches[8]
          assertTrue("Switching must still use the retained branch mode after reentry", model.switchChatSessionBranch(retainedSelection.leafEntryId))
          assertEquals(
            retainedSelection.leafEntryId,
            runtime.chatSessionBranches.value
              .single { it.active }
              .leafEntryId,
          )
          assertEquals(
            retainedSelection.leafEntryId,
            runtime.chatMessages.value
              .last()
              .entryId,
          )
          assertEquals(0, runtime.pendingRunCount.value)
          model.enterScreenshotFixtureMode(scene)
          assertSame(runtime, app.ensureScreenshotFixtureRuntime())
          assertEquals(
            retainedSelection.leafEntryId,
            runtime.chatSessionBranches.value
              .single { it.active }
              .leafEntryId,
          )

          store.clear()
          val reentered = MainViewModel(app, prefs, SavedStateHandle())
          store.put("branches-reentered", reentered)
          reentered.enterScreenshotFixtureMode(scene)
          reentered.loadCurrentChat()
          reentered.chatMessages.first { it.lastOrNull()?.entryId == retainedSelection.leafEntryId }
          assertSame("A new ViewModel must retain the process-owned fixture runtime", runtime, app.peekRuntime())
          assertTrue(reentered.refreshChatSessionBranches())
          assertEquals(
            retainedSelection.leafEntryId,
            runtime.chatSessionBranches.value
              .single { it.active }
              .leafEntryId,
          )
          assertTrue(reentered.switchChatSessionBranch(branches.last().leafEntryId))
          assertEquals(
            branches.last().leafEntryId,
            runtime.chatMessages.value
              .last()
              .entryId,
          )
        }
      }
    } finally {
      store.clear()
      bindNodeRuntimeTestFixture(app, null)
      closeNodeRuntimeTestFixture(runtime)
    }
  }

  @Test
  fun branchRequestersKeepIndependentSelectionsAndRejectInvalidRequestsWithoutEffects() {
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Branches)
    val first = newRuntimeRequester()
    val second = newRuntimeRequester()
    val initialSecond = branchSnapshot(second)
    val leaves =
      response(first, "sessions.branches.list", branchParams())["branches"]!!.jsonArray.map {
        it.jsonObject
          .getValue("leafEntryId")
          .jsonPrimitive.content
      }
    assertEquals(12, leaves.size)
    assertEquals(12, leaves.toSet().size)
    val answers = mutableSetOf<String>()
    val commonPrompt = response(first, "chat.history", branchParams()).getValue("messages").jsonArray.first()
    leaves.forEach { leaf ->
      val switched = response(first, "sessions.branches.switch", branchParams(leaf))
      assertEquals("The protocol acknowledges branch switches with an empty result", JsonObject(emptyMap()), switched)
      val (listing, history, sessions) = branchSnapshot(first)
      val active =
        listing
          .getValue("branches")
          .jsonArray
          .single {
            it.jsonObject
              .getValue("active")
              .jsonPrimitive.boolean
          }.jsonObject
      val messages = history.getValue("messages").jsonArray
      val tip = messages.last().jsonObject
      val session =
        sessions
          .getValue("sessions")
          .jsonArray
          .single()
          .jsonObject
      assertEquals(leaf, active.getValue("leafEntryId").jsonPrimitive.content)
      assertEquals(
        leaf,
        tip
          .getValue("__openclaw")
          .jsonObject
          .getValue("id")
          .jsonPrimitive.content,
      )
      assertEquals(messages.size, active.getValue("messageCount").jsonPrimitive.int)
      assertEquals(messages.size, session.getValue("messageCount").jsonPrimitive.int)
      assertEquals(AndroidScreenshotFixture.mainSessionKey, session.getValue("key").jsonPrimitive.content)
      assertEquals("main", session.getValue("agentId").jsonPrimitive.content)
      assertEquals(session, history.getValue("sessionInfo"))
      assertEquals(Instant.parse(active.getValue("updatedAt").jsonPrimitive.content).toEpochMilli(), tip.getValue("timestamp").jsonPrimitive.long)
      assertEquals(commonPrompt, messages.first())
      assertFalse(history.containsKey("inFlightRun"))
      assertTrue(answers.add(tip.getValue("content").jsonPrimitive.content))
      assertEquals("Switching one requester must not change another", initialSecond, branchSnapshot(second))
    }
    val retained = branchSnapshot(first)
    val owner = Json.parseToJsonElement(branchParams()).jsonObject
    val switch = Json.parseToJsonElement(branchParams(leaves.first())).jsonObject
    for ((method, valid) in listOf("sessions.branches.list" to owner, "sessions.branches.switch" to switch)) {
      val invalid =
        listOf(
          null,
          "{",
          "null",
          "[]",
          "{}",
          JsonObject(valid - "sessionKey").toString(),
          JsonObject(valid - "agentId").toString(),
          JsonObject(valid + ("sessionKey" to JsonPrimitive("agent:main:another-session"))).toString(),
          JsonObject(valid + ("agentId" to JsonPrimitive("other"))).toString(),
          JsonObject(valid + ("agentId" to JsonPrimitive(1))).toString(),
          JsonObject(valid + ("unexpected" to JsonPrimitive(true))).toString(),
        ) +
          if (method == "sessions.branches.switch") {
            listOf(
              owner.toString(),
              JsonObject(switch + ("leafEntryId" to JsonPrimitive(1))).toString(),
              branchParams(""),
              branchParams("unknown-leaf"),
            )
          } else {
            emptyList()
          }
      invalid.forEach { params ->
        assertThrows("$method must reject $params", IllegalArgumentException::class.java) { first(method, params) }
        assertEquals("A rejected request must not mutate the selected branch or transcript", retained, branchSnapshot(first))
        assertEquals(initialSecond, branchSnapshot(second))
      }
    }
    assertEquals("A fresh requester must not inherit another's selected branch", initialSecond, branchSnapshot(newRuntimeRequester()))
    val archived = response(first, "sessions.list", """{"agentId":"main","archived":true,"limit":20}""")
    assertTrue(archived.getValue("sessions").jsonArray.isEmpty())
    assertEquals(retained, branchSnapshot(first))

    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    val legacy = newRuntimeRequester()
    val legacyHistory = response(legacy, "chat.history", null)
    assertEquals("Standalone branch requesters must capture their mode at creation", retained[1], response(first, "chat.history", branchParams()))
    assertEquals(retained, branchSnapshot(first))
    assertEquals(initialSecond, branchSnapshot(second))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Branches)
    assertEquals("Standalone legacy requesters must not acquire branch mode", legacyHistory, response(legacy, "chat.history", branchParams()))
    assertThrows(IllegalStateException::class.java) { legacy("sessions.branches.list", branchParams()) }
    assertThrows(IllegalStateException::class.java) { legacy("sessions.branches.switch", branchParams(leaves.first())) }
    assertEquals(initialSecond, branchSnapshot(newRuntimeRequester()))
  }

  @Test
  fun chatSceneKeepsItsActiveRunAndDoesNotAdvertiseBranches() {
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs = SecurePrefs(app, app.getSharedPreferences("legacy-chat-screenshot-test", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val store = ViewModelStore()
    bindNodeRuntimeTestFixture(app, runtime)
    try {
      val model = MainViewModel(app, prefs, SavedStateHandle())
      store.put("legacy-chat", model)
      model.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
      runtime.loadCurrentChat()
      drainWithMainLooper {
        withTimeout(5_000) {
          runtime.chatMessages.first { it.isNotEmpty() }
          runtime.chatHealthOk.first { it }
          runtime.pendingRunCount.first { it > 0 }
          assertEquals(1, runtime.pendingRunCount.value)
          runtime.refreshChatSessionBranches()
          assertTrue(runtime.chatSessionBranches.value.isEmpty())
          val methods = ReflectionHelpers.getField<Set<String>>(runtime, "gatewayAdvertisedMethods")
          assertFalse(methods.contains("sessions.branches.list"))
          assertFalse(methods.contains("sessions.branches.switch"))
          val request = runtimeRequester(runtime)
          val history = response(request, "chat.history", branchParams())
          model.enterScreenshotFixtureMode(AndroidScreenshotScene.Branches)
          assertSame(runtime, app.ensureScreenshotFixtureRuntime())
          assertSame(request, runtimeRequester(runtime))
          assertEquals(1, runtime.pendingRunCount.value)
          val advertises = runtimeMethodPredicate(runtime)
          val advertised = ReflectionHelpers.getField<Set<String>>(runtime, "gatewayAdvertisedMethods")
          assertEquals(
            "A legacy runtime must not acquire branch predicates during reentry",
            listOf(false, false, false, false),
            listOf(
              advertises("sessions.branches.list"),
              advertises("sessions.branches.switch"),
              "sessions.branches.list" in advertised,
              "sessions.branches.switch" in advertised,
            ),
          )
          assertEquals(history, response(request, "chat.history", branchParams()))
          assertThrows(IllegalStateException::class.java) { request("sessions.branches.list", branchParams()) }
          assertThrows(IllegalStateException::class.java) { request("sessions.branches.switch", branchParams("unknown")) }
          val runtimeJob = checkNotNull(ReflectionHelpers.getField<CoroutineScope>(runtime, "scope").coroutineContext[Job])
          val priorJobs = runtimeJob.children.toSet()
          model.refreshChat()
          runtimeJob.children
            .filterNot { it in priorJobs }
            .toList()
            .joinAll()
          assertEquals(1, runtime.pendingRunCount.value)
          assertTrue(runtime.chatSessionBranches.value.isEmpty())
        }
      }
      val request = runtimeRequester(runtime)
      assertEquals(
        "android-screenshot-active-run",
        response(request, "chat.history", null)
          .getValue("inFlightRun")
          .jsonObject
          .getValue("runId")
          .jsonPrimitive.content,
      )
      assertThrows(IllegalStateException::class.java) { request("sessions.branches.list", branchParams()) }
      assertThrows(IllegalStateException::class.java) { request("sessions.branches.switch", branchParams("unknown")) }
    } finally {
      store.clear()
      bindNodeRuntimeTestFixture(app, null)
      closeNodeRuntimeTestFixture(runtime)
    }
  }

  @Test
  fun screenshotRuntimeUsesIsolatedInMemoryStoresWithoutRecoveringOperatorSends() {
    val application = RuntimeEnvironment.getApplication()
    val operatorDatabases = AndroidClientDatabases.start(application)
    val operatorOutbox = operatorDatabases.commandOutbox()
    try {
      drainWithMainLooper {
        val item =
          (operatorOutbox.enqueue("operator-gateway", "main", "retained input", "off", 1, ownerAgentId = "main") as ChatOutboxEnqueueResult.Queued).item
        operatorOutbox.updateStatusIfAttempt(item.id, item.attemptVersion, ChatOutboxStatus.Sending, 0, null)
      }
      val prefs = SecurePrefs(application, application.getSharedPreferences("screenshot-test", Context.MODE_PRIVATE))
      val runtime = NodeRuntime(application, prefs, NodeRuntimeMode.ScreenshotFixture)
      try {
        val stores = ReflectionHelpers.getField<AndroidClientDatabases>(runtime, "clientDatabases")
        drainWithMainLooper {
          assertEquals("Synthetic client state must stay in memory", "", stores.clientStateDatabase().mainDatabaseFile())
          assertEquals("Synthetic gateway cache must stay in memory", "", stores.gatewayCacheDatabase().mainDatabaseFile())
        }
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
      drainWithMainLooper {
        assertEquals("Fixture startup must not recover the operator's sends", ChatOutboxStatus.Sending, operatorOutbox.load("operator-gateway").single().status)
      }
    } finally {
      operatorDatabases.close()
    }
  }

  @Test
  fun newRuntimeGetsFreshQuestionWhileExistingRequesterKeepsItsRecord() {
    val firstCreatedAtMs = SystemClock.uptimeMillis()
    val firstRequester = newRuntimeRequester()
    val first = question(firstRequester)
    // Instrument only the fixture: its System clock must share Robolectric's virtual time.
    assertEquals("Fixture clock must be controlled before testing expiry", firstCreatedAtMs, first.createdAtMs)
    assertEquals(firstCreatedAtMs + 600_000, first.expiresAtMs)
    assertEquals(ChatQuestionStatus.Pending, ChatQuestionPrompt(first).status(firstCreatedAtMs))

    ShadowSystemClock.advanceBy(Duration.ofSeconds(1))
    assertEquals("Repeated lists must preserve the complete record", first, question(firstRequester))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    assertEquals("Scene re-entry must not restart a runtime's question", first, question(firstRequester))

    ShadowSystemClock.advanceBy(Duration.ofMinutes(10))
    val secondCreatedAtMs = SystemClock.uptimeMillis()
    assertEquals(ChatQuestionStatus.Expired, ChatQuestionPrompt(first).status(secondCreatedAtMs))
    val secondRequester = newRuntimeRequester()
    val second = question(secondRequester)
    assertEquals("A new runtime must not inherit an expired singleton question", secondCreatedAtMs, second.createdAtMs)
    assertEquals(secondCreatedAtMs + 600_000, second.expiresAtMs)
    assertEquals(ChatQuestionStatus.Pending, ChatQuestionPrompt(second).status(secondCreatedAtMs))

    ShadowSystemClock.advanceBy(Duration.ofSeconds(1))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    assertEquals("A new runtime must not replace an older requester's record", first, question(firstRequester))
    assertEquals("The new runtime must keep its own stable record", second, question(secondRequester))
  }

  private suspend fun RoomDatabase.mainDatabaseFile(): String =
    useReaderConnection { connection ->
      connection.usePrepared("PRAGMA database_list") { statement ->
        buildMap {
          while (statement.step()) put(statement.getText(1), statement.getText(2))
        }.getValue("main")
      }
    }

  private fun newRuntimeRequester(): (String, String?) -> String = AndroidScreenshotFixture.createRequester()

  private fun runtimeRequester(runtime: NodeRuntime): (String, String?) -> String = ReflectionHelpers.getField<Lazy<(String, String?) -> String>>(runtime, "screenshotRequester\$delegate").value

  private fun runtimeMethodPredicate(runtime: NodeRuntime): (String) -> Boolean? = ReflectionHelpers.getField(ReflectionHelpers.getField<ChatController>(runtime, "chat"), "gatewayAdvertisesMethod")

  private fun branchParams(leaf: String? = null): String =
    buildJsonObject {
      put("sessionKey", JsonPrimitive(AndroidScreenshotFixture.mainSessionKey))
      put("agentId", JsonPrimitive("main"))
      if (leaf != null) put("leafEntryId", JsonPrimitive(leaf))
    }.toString()

  private fun response(
    request: (String, String?) -> String,
    method: String,
    params: String?,
  ): JsonObject = Json.parseToJsonElement(request(method, params)).jsonObject

  private fun branchSnapshot(request: (String, String?) -> String): List<JsonObject> =
    listOf(
      response(request, "sessions.branches.list", branchParams()),
      response(request, "chat.history", branchParams()),
      response(request, "sessions.list", """{"includeGlobal":true,"includeUnknown":false,"agentId":"main","limit":20}"""),
    )

  private fun question(request: (String, String?) -> String): QuestionRecord = Json.decodeFromString<QuestionListResult>(request("question.list", "{}")).questions.single()
}
