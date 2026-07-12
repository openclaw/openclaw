package ai.openclaw.app.i18n

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.os.LocaleList
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
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

// Both cached contexts are process-owned: install stores applicationContext,
// and localizedContext is derived from it solely for the selected app locale.
@SuppressLint("StaticFieldLeak")
internal object NativeStringResources {
  @Volatile
  private var applicationContext: Context? = null

  @Volatile
  private var localizedContext: Context? = null

  @Volatile
  private var localizedTags: String? = null

  @Synchronized
  fun install(context: Context) {
    applicationContext = context.applicationContext
    localizedContext = null
    localizedTags = null
  }

  fun resolve(
    source: String,
    vararg formatArgs: Any,
  ): String {
    val context = applicationContext ?: return formatNativeSource(source, formatArgs)
    val appLocales = AppCompatDelegate.getApplicationLocales()
    val tags = appLocales.toLanguageTags()
    val cached = localizedContext
    val localized =
      if (cached != null && localizedTags == tags) {
        cached
      } else {
        synchronized(this) {
          if (localizedContext == null || localizedTags != tags) {
            localizedContext = context.localizedContext(appLocales)
            localizedTags = tags
          }
          localizedContext ?: context
        }
      }
    return localized.nativeString(source, *formatArgs)
  }
}

private fun Context.localizedContext(appLocales: androidx.core.os.LocaleListCompat): Context {
  if (appLocales.isEmpty) return this
  val locales = Array(appLocales.size()) { index -> checkNotNull(appLocales[index]) }
  val configuration = Configuration(resources.configuration).apply { setLocales(LocaleList(*locales)) }
  return createConfigurationContext(configuration)
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

private val nativeInterpolationPattern = Regex("""\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^{}]+})""")

private fun formatNativeSource(
  source: String,
  formatArgs: Array<out Any>,
): String {
  if (formatArgs.isEmpty()) return source
  var index = 0
  return nativeInterpolationPattern.replace(source) { match ->
    formatArgs.getOrNull(index++)?.toString() ?: match.value
  }
}
