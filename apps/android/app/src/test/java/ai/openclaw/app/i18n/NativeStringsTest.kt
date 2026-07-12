package ai.openclaw.app.i18n

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
class NativeStringsTest {
  @Test
  fun sourceFallbackFormatsNestedKotlinInterpolations() {
    assertEquals(
      "2/3 fallback active tokens",
      nativeString(
        """${'$'}{device.tokens.count { !it.revoked }}/${'$'}{device.tokens.size} fallback active tokens""",
        2,
        3,
      ),
    )
  }

  @Test
  fun resolvingStateFlowEmitsWhenThePersistedAppLocaleChanges() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      NativeStringResources.install(app)
      persistAppLocales(app, "en")
      val resolved = MutableStateFlow(nativeText("Mic off")).resolveNativeText()
      val firstEmission = CompletableDeferred<Unit>()
      val emissions = mutableListOf<String>()
      val collection =
        launch(start = CoroutineStart.UNDISPATCHED) {
          resolved.take(2).collect { value ->
            emissions += value
            if (emissions.size == 1) firstEmission.complete(Unit)
          }
        }

      try {
        firstEmission.await()
        persistAppLocales(app, "fr")
        notifyNativeLocaleChanged()
        collection.join()

        assertEquals(listOf("Mic off", "Micro désactivé"), emissions)
      } finally {
        collection.cancel()
        app.deleteFile(APP_LOCALES_FILE)
      }
    }

  private fun persistAppLocales(
    context: Context,
    languageTags: String,
  ) {
    context.openFileOutput(APP_LOCALES_FILE, Context.MODE_PRIVATE).bufferedWriter().use { writer ->
      writer.write("""<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><locales application_locales="$languageTags" />""")
    }
  }

  private companion object {
    const val APP_LOCALES_FILE = "androidx.appcompat.app.AppCompatDelegate.application_locales_record_file"
  }
}
