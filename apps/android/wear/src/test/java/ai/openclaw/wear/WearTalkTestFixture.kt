package ai.openclaw.wear

import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearRealtimeTalkCodec
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRpcMethod
import android.content.Context
import android.net.Uri
import android.os.Parcel
import com.google.android.gms.common.api.GoogleApi
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.ChannelClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

// Controlled transport only: lifecycle, audio, ViewModel, and UI remain production owners.
internal class WearTalkTestFixture(
  context: Context,
  targetClient: WearRealtimeTalkClient? = null,
  private val startReply: (suspend (String) -> WearRealtimeTalkSnapshot)? = null,
) {
  val events = java.util.concurrent.CopyOnWriteArrayList<String>()
  val input = BlockingInput()
  val output = CountingOutput()
  val rpcEntered = CompletableDeferred<Unit>()
  val rpcReply = CompletableDeferred<Unit>()
  val channelCloses = AtomicInteger()
  val requester =
    object : WearRpcRequester {
      override suspend fun request(
        method: WearRpcMethod,
        params: JsonObject,
        expectedNodeId: String?,
        requirePreferredNode: Boolean,
      ): WearRpcResult {
        check(expectedNodeId == "phone-a" && requirePreferredNode)
        val attemptId = checkNotNull(params["attemptId"]).jsonPrimitive.content
        if (method == WearRpcMethod.TalkStart) {
          val snapshot = checkNotNull(startReply)(attemptId)
          return WearRpcResult(WearRealtimeTalkCodec.encode(snapshot), null, "phone-a")
        }
        check(method == WearRpcMethod.TalkStop)
        mark("rpc-enter")
        rpcEntered.complete(Unit)
        rpcReply.await()
        mark("rpc-reply")
        return WearRpcResult(WearRealtimeTalkCodec.encode(WearRealtimeTalkSnapshot(attemptId = attemptId)), null, "phone-a")
      }
    }
  val repository = WearGatewayRepository(requester)
  val client = targetClient ?: WearRealtimeTalkClient(context, repository)
  val channel =
    object : ChannelClient.Channel {
      override fun getNodeId(): String = "phone-a"

      override fun getPath(): String = WearProtocol.realtimeAudioChannelPath("attempt-1")

      override fun describeContents(): Int = 0

      override fun writeToParcel(
        dest: Parcel,
        flags: Int,
      ) = Unit
    }
  val attempt =
    WearRealtimeTalkClient.ActiveAttempt(
      nodeId = "phone-a",
      attemptId = "attempt-1",
      generation = 1L,
      resources = WearRealtimeTalkClient.ChannelResources(channel, input, output),
    )

  init {
    client.setTalkTestField("repository", repository)
    client.setTalkTestField(
      "channelClient",
      object : ChannelClient(context, GoogleApi.Settings.DEFAULT_SETTINGS) {
        override fun close(channel: Channel): Task<Void> {
          channelCloses.incrementAndGet()
          mark("channel-close")
          return Tasks.forResult(null)
        }

        override fun close(
          channel: Channel,
          errorCode: Int,
        ): Task<Void> = close(channel)

        override fun openChannel(
          nodeId: String,
          path: String,
        ): Task<Channel> {
          check(startReply != null && nodeId == "phone-a")
          return Tasks.forResult(channel)
        }

        override fun getInputStream(channel: Channel): Task<InputStream> = Tasks.forResult(input)

        override fun getOutputStream(channel: Channel): Task<OutputStream> = Tasks.forResult(output)

        override fun registerChannelCallback(callback: ChannelCallback): Task<Void> = error("unused")

        override fun registerChannelCallback(
          channel: Channel,
          callback: ChannelCallback,
        ): Task<Void> = error("unused")

        override fun unregisterChannelCallback(callback: ChannelCallback): Task<Boolean> = error("unused")

        override fun unregisterChannelCallback(
          channel: Channel,
          callback: ChannelCallback,
        ): Task<Boolean> = error("unused")

        override fun receiveFile(
          channel: Channel,
          uri: Uri,
          append: Boolean,
        ): Task<Void> = error("unused")

        override fun sendFile(
          channel: Channel,
          uri: Uri,
        ): Task<Void> = error("unused")

        override fun sendFile(
          channel: Channel,
          uri: Uri,
          offset: Long,
          length: Long,
        ): Task<Void> = error("unused")
      },
    )
  }

  fun activate() = client.callTalkTestMethod("activate", attempt)

  fun mark(event: String) {
    events.add("${System.nanoTime()} $event")
  }

  inner class BlockingInput : InputStream() {
    val entered = CountDownLatch(1)
    val released = CountDownLatch(1)
    val closes = AtomicInteger()

    override fun read(): Int {
      entered.countDown()
      check(released.await(10, TimeUnit.SECONDS)) { "reader was not closed" }
      return -1
    }

    override fun close() {
      closes.incrementAndGet()
      mark("input-close")
      released.countDown()
    }
  }

  inner class CountingOutput : OutputStream() {
    val closes = AtomicInteger()

    override fun write(value: Int) = Unit

    override fun close() {
      closes.incrementAndGet()
      mark("output-close")
    }
  }
}

internal fun Any.setTalkTestField(
  name: String,
  value: Any?,
) {
  javaClass.getDeclaredField(name).apply { isAccessible = true }.set(this, value)
}

internal fun Any.talkTestField(name: String): Any? = javaClass.getDeclaredField(name).apply { isAccessible = true }.get(this)

internal fun Any.callTalkTestMethod(
  name: String,
  vararg args: Any?,
) {
  javaClass.declaredMethods
    .single { it.name == name && it.parameterCount == args.size }
    .apply { isAccessible = true }
    .invoke(this, *args)
}
