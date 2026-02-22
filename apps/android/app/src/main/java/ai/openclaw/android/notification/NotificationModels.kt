package ai.openclaw.android.notification

import kotlinx.serialization.Serializable

@Serializable
data class CapturedNotification(
  val id: String,
  /** The system key from StatusBarNotification.getKey(), needed for cancelNotification(). */
  val key: String,
  val packageName: String,
  val appLabel: String,
  val title: String?,
  val text: String?,
  val timestamp: Long,
  val priority: Int,
  val category: String?,
  val groupKey: String?,
  val isOngoing: Boolean,
  val isGroupSummary: Boolean,
)

@Serializable
data class NotificationBatch(
  val batchId: String,
  val nodeId: String,
  val notifications: List<CapturedNotification>,
  val batchedAtMs: Long,
  val windowMs: Long,
)

@Serializable
data class DismissResult(
  val dismissed: Boolean,
  val key: String?,
  val error: String? = null,
)
