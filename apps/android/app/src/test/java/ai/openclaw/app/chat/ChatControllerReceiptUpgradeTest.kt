package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import androidx.room3.Room
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.nio.file.Files

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerReceiptUpgradeTest {
  @Test
  fun preUpgradeDiskOutboxDatabaseLoadsAndReconcilesOriginalIdsAfterUpgrade() =
    runTest {
      val dbDir = Files.createTempDirectory("outbox-upgrade-proof")
      val dbPath = dbDir.resolve("client-state.db").toFile().absolutePath
      val queryContext = coroutineContext.minusKey(Job)
      val now = System.currentTimeMillis()
      val preUpgradeDb =
        Room
          .databaseBuilder(RuntimeEnvironment.getApplication(), ClientStateDatabase::class.java, dbPath)
          .setQueryCoroutineContext(queryContext)
          .build()
      try {
        val legacyOutbox = RoomChatCommandOutbox(preUpgradeDb)
        val accepted =
          (
            legacyOutbox.enqueue(
              gatewayId = "gateway-test",
              sessionKey = "agent:main:queue",
              text = "legacy accepted",
              thinkingLevel = "off",
              nowMs = now - 3_000,
              ownerAgentId = "main",
              idempotencyKey = "pre-accepted",
            ) as ChatOutboxEnqueueResult.Queued
          ).item
        legacyOutbox.updateStatusIfAttempt(accepted.id, accepted.attemptVersion, ChatOutboxStatus.Accepted, 0, null)
        val failed =
          (
            legacyOutbox.enqueue(
              gatewayId = "gateway-test",
              sessionKey = "agent:main:queue",
              text = "legacy uncertain",
              thinkingLevel = "off",
              nowMs = now - 2_000,
              ownerAgentId = "main",
              idempotencyKey = "pre-failed",
            ) as ChatOutboxEnqueueResult.Queued
          ).item
        legacyOutbox.updateStatusIfAttempt(failed.id, failed.attemptVersion, ChatOutboxStatus.Failed, 0, OUTBOX_DELIVERY_UNCONFIRMED_ERROR)
      } finally {
        preUpgradeDb.close()
      }

      val upgradedDb =
        Room
          .databaseBuilder(RuntimeEnvironment.getApplication(), ClientStateDatabase::class.java, dbPath)
          .setQueryCoroutineContext(queryContext)
          .build()
      try {
        val requests = mutableListOf<Pair<String, JsonObject>>()
        var failSend: Throwable? = GatewayRequestOutcomeUnknown("socket closed before ACK")
        val controller =
          ChatController(
            scope = backgroundScope,
            json = chatControllerTestJson,
            commandOutbox = RoomChatCommandOutbox(upgradedDb),
            cacheScope = { ChatCacheScope("gateway-test", 1L) },
            gatewayAdvertisesCapability = { it == "chat-input-custody-v1" },
            requestGateway = { method, params ->
              val input = params?.let { chatControllerTestJson.parseToJsonElement(it) as JsonObject } ?: JsonObject(emptyMap())
              requests += method to input
              when (method) {
                "chat.history" -> {
                  """{"sessionId":"physical-1","messages":[],"inputReceipts":[{"runId":"pre-accepted","state":"consumed","consumedByEventId":"evt-legacy-1"}]}"""
                }

                "chat.send" -> {
                  failSend?.let { throw it }
                  """{"runId":"alias-1","status":"started"}"""
                }

                else -> {
                  emptyChatGatewayResponse(method)
                }
              }
            },
          )
        controller.load("agent:main:queue")
        runCurrent()
        val queriedIds =
          requests.filter { it.first == "chat.history" }.flatMap { (_, params) ->
            (params["inputRunIds"] as? JsonArray).orEmpty().map { (it as JsonPrimitive).content }
          }
        assertTrue("Expected chat.history inputRunIds to query stored pre-upgrade IDs, got $queriedIds", queriedIds.containsAll(listOf("pre-accepted", "pre-failed")))
        assertEquals(
          listOf("pre-failed"),
          controller.outboxItems.value
            .map { it.id },
        )
        assertEquals(0, requests.count { it.first == "chat.send" })
      } finally {
        upgradedDb.close()
        dbDir.toFile().deleteRecursively()
      }
    }
}
