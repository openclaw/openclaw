package ai.openclaw.app.i18n

import android.content.Context
import android.content.res.Configuration
import android.os.LocaleList
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource

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
    val context = applicationContext ?: return source
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
  val resourceId = nativeStringResourceIds[source] ?: return source
  return if (formatArgs.isEmpty()) stringResource(resourceId) else stringResource(resourceId, *formatArgs)
}

internal fun Context.nativeString(
  source: String,
  vararg formatArgs: Any,
): String {
  val resourceId = nativeStringResourceIds[source] ?: return source
  return if (formatArgs.isEmpty()) getString(resourceId) else getString(resourceId, *formatArgs)
}
