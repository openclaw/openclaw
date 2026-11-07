package ai.openclaw.app

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.IntentCompat
import java.util.Locale

/** Android Assistant entry point used by manifest-declared app actions. */
const val actionAskOpenClaw = "ai.openclaw.app.action.ASK_OPENCLAW"

/** Debug action that opens the Voice tab directly for Android E2E automation. */
val actionOpenVoiceE2e = "${BuildConfig.APPLICATION_ID}.OPEN_VOICE_E2E"

/** Intent extra that carries an optional assistant prompt for app actions. */
const val extraAssistantPrompt = "prompt"

/**
 * Top-level home destinations that external actions may request.
 */
enum class HomeDestination {
  Connect,
  Chat,
  Voice,
  Settings,
}

/**
 * Normalized launch request from Android Assistant or explicit app actions.
 */
data class AssistantLaunchRequest(
  val source: String,
  val prompt: String?,
  val autoSend: Boolean,
)

/** Shared content staged in chat for user review before sending. */
data class ShareLaunchRequest(
  val text: String?,
  val attachments: List<SharedAttachment>,
  val droppedAttachmentCount: Int,
  val unsupportedAttachmentCount: Int = 0,
)

enum class SharedAttachmentKind {
  Image,
  Audio,
  Video,
  Document,
}

data class SharedAttachment(
  val uri: Uri,
  val kind: SharedAttachmentKind,
  val mimeType: String,
)

internal val SHARED_ATTACHMENT_MIME_ALLOWLIST =
  setOf(
    "image/*",
    "audio/*",
    "video/*",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/csv",
    "text/markdown",
  )

/**
 * Parses app-owned navigation actions that should open a specific home tab.
 */
fun parseHomeDestinationIntent(intent: Intent?): HomeDestination? {
  val action = intent?.action ?: return null
  // Debug-only shortcut keeps E2E navigation out of release builds.
  return if (BuildConfig.DEBUG && action == actionOpenVoiceE2e) HomeDestination.Voice else null
}

/**
 * Parse external assistant entry points without starting any UI side effects.
 */
fun parseAssistantLaunchIntent(intent: Intent?): AssistantLaunchRequest? {
  val action = intent?.action ?: return null
  val source =
    when (action) {
      Intent.ACTION_ASSIST -> "assist"
      actionAskOpenClaw -> "app_action"
      else -> return null
    }
  return AssistantLaunchRequest(
    source = source,
    prompt = if (action == actionAskOpenClaw) intent.getStringExtra(extraAssistantPrompt)?.trim()?.ifEmpty { null } else null,
    autoSend = false,
  )
}

/** Parses Android Sharesheet metadata without opening or reading shared payload bytes. */
fun parseShareLaunchIntent(
  intent: Intent?,
  resolveMimeType: (Uri) -> String?,
  resolveDisplayName: (Uri) -> String? = { null },
): ShareLaunchRequest? {
  val action = intent?.action ?: return null
  if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

  val indexedText =
    if (action == Intent.ACTION_SEND_MULTIPLE) intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT) else null
  val text =
    listOf(intent.getStringExtra(Intent.EXTRA_SUBJECT))
      .plus(indexedText ?: listOfNotNull(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)))
      .plus(intent.clipData?.run { (0 until itemCount).map { getItemAt(it).text } }.orEmpty())
      .mapNotNull { value -> value?.toString()?.trim()?.takeIf { it.isNotEmpty() } }
      .distinct()
      .joinToString(separator = "\n\n")
      .ifEmpty { null }
  val streamUris =
    if (action == Intent.ACTION_SEND) {
      listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
    } else {
      IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
    }
  val clipUris =
    intent.clipData
      ?.let { clip ->
        (0 until clip.itemCount).mapNotNull { index -> clip.getItemAt(index).uri }
      }.orEmpty()

  // Only provider-backed content URIs use the sender's temporary read grant. Rejecting file://
  // prevents an external intent from turning OpenClaw into a reader for its own private files.
  val validUris =
    (streamUris + clipUris)
      .filter { uri -> uri.scheme.equals(ContentResolver.SCHEME_CONTENT, ignoreCase = true) }
      .distinct()
  val fallbackMimeType =
    sharedAttachmentMimeTypeForAdmission(intent.type)
      ?.takeIf { sharedAttachmentKindForMimeType(it) != null }
  val resolved = mutableListOf<SharedAttachment>()
  var unsupportedAttachmentCount = 0
  for (uri in validUris) {
    // Once the cap is full, further files are limit omissions, not type rejections.
    if (resolved.size >= MAX_SHARED_ATTACHMENT_COUNT) continue
    val providerMimeType =
      try {
        normalizeSharedAttachmentMimeType(resolveMimeType(uri))
      } catch (_: Exception) {
        null
      }
    val displayName =
      try {
        resolveDisplayName(uri)?.trim()?.takeIf { it.isNotEmpty() }
      } catch (_: Exception) {
        null
      }
    val mimeType = sharedAttachmentMimeTypeForAdmission(providerMimeType ?: fallbackMimeType, displayName)
    val kind =
      sharedAttachmentKindForMimeType(mimeType) ?: run {
        unsupportedAttachmentCount += 1
        continue
      }
    resolved += SharedAttachment(uri = uri, kind = kind, mimeType = requireNotNull(mimeType))
  }
  if (text == null && validUris.isEmpty()) return null
  return ShareLaunchRequest(
    text = text,
    attachments = resolved,
    droppedAttachmentCount = validUris.size - resolved.size,
    unsupportedAttachmentCount = unsupportedAttachmentCount,
  )
}

/** A picked or shared file is outside the curated allowlist from #110941. */
internal class UnsupportedSharedAttachmentException : IllegalStateException("unsupported attachment")

internal fun sharedAttachmentKindForMimeType(mimeType: String?): SharedAttachmentKind? {
  val normalized = canonicalSharedAttachmentMimeType(mimeType) ?: return null
  // Image pickers may supply image/*; other media must name a concrete type.
  if (normalized.endsWith("/*") && !normalized.startsWith("image/")) return null
  return when {
    normalized.startsWith("image/") -> SharedAttachmentKind.Image
    normalized.startsWith("audio/") -> SharedAttachmentKind.Audio
    normalized.startsWith("video/") -> SharedAttachmentKind.Video
    normalized in SHARED_ATTACHMENT_MIME_ALLOWLIST -> SharedAttachmentKind.Document
    else -> null
  }
}

/**
 * Maps provider MIME aliases onto the allowlisted type, and uses a display-name
 * extension only when the provider says nothing more specific than octet-stream.
 * Extensions cannot admit a type that is not already on the allowlist.
 */
internal fun sharedAttachmentMimeTypeForAdmission(
  rawMimeType: String?,
  displayName: String? = null,
): String? {
  val canonical = canonicalSharedAttachmentMimeType(rawMimeType)
  if (canonical != null && canonical != "application/octet-stream") return canonical
  return allowlistedDocumentMimeTypeForDisplayName(displayName) ?: canonical
}

internal fun canonicalSharedAttachmentMimeType(mimeType: String?): String? {
  val normalized = normalizeSharedAttachmentMimeType(mimeType) ?: return null
  return when (normalized) {
    "text/comma-separated-values", "text/x-csv" -> "text/csv"
    "text/x-markdown" -> "text/markdown"
    else -> normalized
  }
}

internal fun allowlistedDocumentMimeTypeForDisplayName(displayName: String?): String? {
  val trimmed = displayName?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val extension =
    trimmed
      .substringAfterLast('.', "")
      .lowercase(Locale.US)
      .takeIf { it.isNotEmpty() && !trimmed.equals(it, ignoreCase = true) }
      ?: return null
  return ALLOWLISTED_DOCUMENT_EXTENSIONS[extension]
}

internal fun sharedAttachmentDisplayName(
  resolver: ContentResolver,
  uri: Uri,
): String? =
  try {
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (!cursor.moveToFirst()) return@use null
      val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
      if (index < 0 || cursor.isNull(index)) return@use null
      cursor.getString(index)?.trim()?.takeIf { it.isNotEmpty() }
    }
  } catch (_: Exception) {
    null
  }

internal fun normalizeSharedAttachmentMimeType(mimeType: String?): String? =
  mimeType
    ?.substringBefore(';')
    ?.trim()
    ?.lowercase(Locale.US)
    ?.takeIf { it.isNotEmpty() }

private val ALLOWLISTED_DOCUMENT_EXTENSIONS =
  mapOf(
    "pdf" to "application/pdf",
    "csv" to "text/csv",
    "md" to "text/markdown",
    "markdown" to "text/markdown",
    "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  )

private const val MAX_SHARED_ATTACHMENT_COUNT = 8
