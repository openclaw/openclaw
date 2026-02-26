package ai.openclaw.android.node

import android.content.Context
import ai.openclaw.android.gateway.GatewaySession
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal interface NotificationsStateProvider {
  fun readSnapshot(context: Context): DeviceNotificationSnapshot

  fun requestServiceRebind(context: Context)
}

private object SystemNotificationsStateProvider : NotificationsStateProvider {
  override fun readSnapshot(context: Context): DeviceNotificationSnapshot {
    val enabled = DeviceNotificationListenerService.isAccessEnabled(context)
    if (!enabled) {
      return DeviceNotificationSnapshot(
        enabled = false,
        connected = false,
        notifications = emptyList(),
      )
    }
    return DeviceNotificationListenerService.snapshot(context, enabled = true)
  }

  override fun requestServiceRebind(context: Context) {
    DeviceNotificationListenerService.requestServiceRebind(context)
  }
}

class NotificationsHandler private constructor(
  private val appContext: Context,
  private val stateProvider: NotificationsStateProvider,
) {
  constructor(appContext: Context) : this(appContext = appContext, stateProvider = SystemNotificationsStateProvider)

  suspend fun handleNotificationsList(_paramsJson: String?): GatewaySession.InvokeResult {
    val snapshot = stateProvider.readSnapshot(appContext)
    if (snapshot.enabled && !snapshot.connected) {
      stateProvider.requestServiceRebind(appContext)
    }
    return GatewaySession.InvokeResult.ok(snapshotPayloadJson(snapshot))
  }

  private fun snapshotPayloadJson(snapshot: DeviceNotificationSnapshot): String {
    return buildJsonObject {
      put("enabled", JsonPrimitive(snapshot.enabled))
      put("connected", JsonPrimitive(snapshot.connected))
      put("count", JsonPrimitive(snapshot.notifications.size))
      put(
        "notifications",
        JsonArray(
          snapshot.notifications.map { entry ->
            buildJsonObject {
              put("key", JsonPrimitive(entry.key))
              put("packageName", JsonPrimitive(entry.packageName))
              put("postTimeMs", JsonPrimitive(entry.postTimeMs))
              put("isOngoing", JsonPrimitive(entry.isOngoing))
              put("isClearable", JsonPrimitive(entry.isClearable))
              entry.title?.let { put("title", JsonPrimitive(it)) }
              entry.text?.let { put("text", JsonPrimitive(it)) }
              entry.subText?.let { put("subText", JsonPrimitive(it)) }
              entry.category?.let { put("category", JsonPrimitive(it)) }
              entry.channelId?.let { put("channelId", JsonPrimitive(it)) }
            }
          },
        ),
      )
    }.toString()
  }

  companion object {
    internal fun forTesting(
      appContext: Context,
      stateProvider: NotificationsStateProvider,
    ): NotificationsHandler = NotificationsHandler(appContext = appContext, stateProvider = stateProvider)
  }
}
