package ai.openclaw.app.ui

import ai.openclaw.app.BrowserSignInActivity
import ai.openclaw.app.NodeApp
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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
  // The native operation starts once, before the browser. An activity result must
  // never recreate it (or consume setup credentials for a second handshake).
  val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { }
  if (targetUrl != null) {
    Column {
      launchError?.let { Text(it, maxLines = 2) }
      ClawSecondaryButton(
        text = nativeString("Sign in with browser"),
        onClick = {
          try {
            val login = app.browserSessions.begin(targetUrl.toHttpUrl())
            launcher.launch(Intent(context, BrowserSignInActivity::class.java).putExtra(BrowserSignInActivity.ATTEMPT_ID, login.profileName))
            onConnect()
          } catch (failure: Exception) {
            launchError = failure.message ?: nativeString("Could not open browser sign-in.")
          }
        },
        modifier = Modifier.fillMaxWidth(),
      )
      Text(
        nativeString("For Authelia and other reverse proxies. Your Gateway token may still be required."),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
    }
  }
}
