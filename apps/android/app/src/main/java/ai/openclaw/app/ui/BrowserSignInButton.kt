package ai.openclaw.app.ui

import ai.openclaw.app.BrowserSignInActivity
import ai.openclaw.app.NodeApp
import ai.openclaw.app.gateway.browserSessionOrigin
import ai.openclaw.app.gateway.buildGatewayWebSocketUrl
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawTheme
import android.app.Activity
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request

internal fun browserSignInUrl(
  host: String,
  port: String,
  tls: Boolean,
): String? {
  val config =
    resolveGatewayConnectConfig(
      useSetupCode = false,
      setupCode = "",
      manualHostInput = host,
      manualPortInput = port,
      manualTlsInput = tls,
      bootstrapTokenInput = "",
      tokenInput = "",
      passwordInput = "",
    ) ?: return null
  if (!config.tls) return null
  return Request
    .Builder()
    .url(buildGatewayWebSocketUrl(config.host, config.port, true, config.contextPath))
    .build()
    .url
    .toString()
}

@Composable
internal fun BrowserSignInButton(
  targetUrl: String?,
  onConnect: () -> Unit,
) {
  val context = LocalContext.current
  var launchError by remember { mutableStateOf<String?>(null) }
  val app = context.applicationContext as NodeApp
  val signedInOrigins by app.browserSessions.signedInOrigins.collectAsState()
  val launchScope = rememberCoroutineScope()
  var changingSession by remember { mutableStateOf(false) }
  // The native operation starts once, before the browser. An activity result must
  // never recreate it (or consume setup credentials for a second handshake).
  val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { }
  if (targetUrl != null) {
    Column {
      launchError?.let { Text(it, maxLines = 2) }
      ClawSecondaryButton(
        enabled = !changingSession,
        text = nativeString("Sign in with browser"),
        onClick = {
          changingSession = true
          launchError = null
          launchScope.launch {
            try {
              withContext(Dispatchers.Main.immediate) {
                val login = app.beginBrowserSignIn(targetUrl.toHttpUrl())
                launcher.launch(Intent(context, BrowserSignInActivity::class.java).putExtra(BrowserSignInActivity.ATTEMPT_ID, login.profileName))
                onConnect()
              }
            } catch (cancelled: CancellationException) {
              throw cancelled
            } catch (_: Exception) {
              withContext(Dispatchers.Main.immediate) { launchError = nativeString("Could not open browser sign-in.") }
            } finally {
              withContext(Dispatchers.Main.immediate) { changingSession = false }
            }
          }
        },
        modifier = Modifier.fillMaxWidth(),
      )
      if (targetUrl.toHttpUrl().browserSessionOrigin() in signedInOrigins) {
        ClawSecondaryButton(
          text = nativeString("Sign out of saved browser session"),
          enabled = !changingSession,
          onClick = {
            changingSession = true
            launchError = null
            // Process-owned cleanup survives removal of this card or Activity recreation.
            app.launchRuntimeTask {
              try {
                app.signOutBrowserSession(targetUrl.toHttpUrl())
              } catch (cancelled: CancellationException) {
                throw cancelled
              } catch (_: Exception) {
                withContext(Dispatchers.Main.immediate) { launchError = nativeString("Could not sign out. Try again.") }
              } finally {
                withContext(Dispatchers.Main.immediate) { changingSession = false }
              }
            }
          },
          modifier = Modifier.fillMaxWidth(),
        )
      }
      Text(
        nativeString("For Authelia and other reverse proxies. Your Gateway token may still be required."),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
    }
  }
}
