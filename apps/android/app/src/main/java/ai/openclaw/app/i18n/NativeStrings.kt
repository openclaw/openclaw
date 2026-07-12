package ai.openclaw.app.i18n

import android.annotation.SuppressLint
import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update

sealed interface NativeText {
  data class Resource(
    val source: String,
    val formatArgs: List<Any>,
  ) : NativeText

  data class Verbatim(
    val value: String,
  ) : NativeText

  data class Composite(
    val parts: List<NativeText>,
    val separator: String,
  ) : NativeText
}

private val nativeLocaleRevision = MutableStateFlow(0L)
internal val nativeLocaleChanges: StateFlow<Long> = nativeLocaleRevision.asStateFlow()

internal fun nativeText(
  source: String,
  vararg formatArgs: Any,
): NativeText.Resource = NativeText.Resource(source = source, formatArgs = formatArgs.toList())

internal fun verbatimText(value: String): NativeText = NativeText.Verbatim(value)

internal fun joinedNativeText(
  separator: String,
  parts: List<NativeText>,
): NativeText = NativeText.Composite(parts = parts, separator = separator)

internal fun NativeText.resolveNativeText(): String =
  when (this) {
    is NativeText.Resource -> nativeString(source, *formatArgs.map(::resolveNativeFormatArg).toTypedArray())
    is NativeText.Verbatim -> value
    is NativeText.Composite -> parts.joinToString(separator, transform = NativeText::resolveNativeText)
  }

@Composable
internal fun NativeText.resolveNativeTextResource(): String =
  when (this) {
    is NativeText.Resource -> {
      val resolvedArgs = mutableListOf<Any>()
      for (formatArg in formatArgs) {
        resolvedArgs += if (formatArg is NativeText) formatArg.resolveNativeTextResource() else formatArg
      }
      nativeStringResource(source, *resolvedArgs.toTypedArray())
    }
    is NativeText.Verbatim -> value
    is NativeText.Composite -> {
      val resolvedParts = mutableListOf<String>()
      for (part in parts) {
        resolvedParts += part.resolveNativeTextResource()
      }
      resolvedParts.joinToString(separator)
    }
  }

private fun resolveNativeFormatArg(value: Any): Any = if (value is NativeText) value.resolveNativeText() else value

internal fun notifyNativeLocaleChanged() {
  nativeLocaleRevision.update { it + 1 }
}

@OptIn(ExperimentalForInheritanceCoroutinesApi::class)
private class LocaleResolvingStateFlow<T, R>(
  private val source: StateFlow<T>,
  private val transform: (T) -> R,
) : StateFlow<R> {
  override val value: R
    get() = transform(source.value)

  override val replayCache: List<R>
    get() = listOf(value)

  override suspend fun collect(collector: FlowCollector<R>): Nothing {
    combine(source, nativeLocaleRevision) { value, _ -> transform(value) }
      .distinctUntilChanged()
      .collect(collector)
    error("locale-resolving state flow completed unexpectedly")
  }
}

internal fun StateFlow<NativeText>.resolveNativeText(): StateFlow<String> = LocaleResolvingStateFlow(this, NativeText::resolveNativeText)

internal fun StateFlow<NativeText?>.resolveOptionalNativeText(): StateFlow<String?> = LocaleResolvingStateFlow(this) { text -> text?.resolveNativeText() }

@SuppressLint("StaticFieldLeak")
internal object NativeStringResources {
  @Volatile
  private var applicationContext: Context? = null

  fun install(context: Context) {
    applicationContext = context.applicationContext
  }

  fun resolve(
    source: String,
    vararg formatArgs: Any,
  ): String {
    val context = applicationContext ?: return formatNativeSource(source, formatArgs)
    val localized = ContextCompat.getContextForLanguage(context)
    return localized.nativeString(source, *formatArgs)
  }
}

internal fun nativeString(
  source: String,
  vararg formatArgs: Any,
): String = NativeStringResources.resolve(source, *formatArgs)

@Composable
internal fun nativeStringResource(
  source: String,
  vararg formatArgs: Any,
): String {
  val resourceId = nativeStringResourceIds[source] ?: return formatNativeSource(source, formatArgs)
  return if (formatArgs.isEmpty()) stringResource(resourceId) else stringResource(resourceId, *formatArgs)
}

internal fun Context.nativeString(
  source: String,
  vararg formatArgs: Any,
): String {
  val resourceId = nativeStringResourceIds[source] ?: return formatNativeSource(source, formatArgs)
  return if (formatArgs.isEmpty()) getString(resourceId) else getString(resourceId, *formatArgs)
}

private fun formatNativeSource(
  source: String,
  formatArgs: Array<out Any>,
): String {
  if (formatArgs.isEmpty()) return source
  val rendered = StringBuilder(source.length)
  var argumentIndex = 0
  var cursor = 0
  while (cursor < source.length) {
    val start = source.indexOf('$', startIndex = cursor)
    if (start < 0) {
      rendered.append(source, cursor, source.length)
      break
    }
    rendered.append(source, cursor, start)
    val end = source.kotlinInterpolationEnd(start)
    if (end == null) {
      rendered.append('$')
      cursor = start + 1
      continue
    }
    val argument = formatArgs.getOrNull(argumentIndex++)
    if (argument == null) {
      rendered.append(source, start, end)
    } else {
      rendered.append(argument)
    }
    cursor = end
  }
  return rendered.toString()
}

private fun String.kotlinInterpolationEnd(start: Int): Int? {
  val next = getOrNull(start + 1) ?: return null
  if (next != '{') {
    if (next != '_' && !next.isLetter()) return null
    var end = start + 2
    while (getOrNull(end)?.let { it == '_' || it.isLetterOrDigit() } == true) {
      end += 1
    }
    return end
  }

  var depth = 1
  var quote: Char? = null
  var escaped = false
  var end = start + 2
  while (end < length) {
    val character = this[end]
    when {
      escaped -> escaped = false
      quote != null && character == '\\' -> escaped = true
      character == quote -> quote = null
      quote == null && (character == '"' || character == '\'') -> quote = character
      quote == null && character == '{' -> depth += 1
      quote == null && character == '}' -> {
        depth -= 1
        if (depth == 0) return end + 1
      }
    }
    end += 1
  }
  return null
}
