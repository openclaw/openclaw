package ai.openclaw.app.ui

import ai.openclaw.app.BrowserSignInActivity
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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
  onSignedIn: () -> Unit,
) {
  val context = LocalContext.current
  val launcher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      // A result for edited/replaced endpoint fields cannot connect a different target.
      if (result.resultCode == Activity.RESULT_OK && result.data?.getStringExtra(BrowserSignInActivity.TARGET_URL) == targetUrl) {
        onSignedIn()
      }
    }
  if (targetUrl != null) {
    Column {
      ClawSecondaryButton(
        text = nativeString("Sign in with browser"),
        onClick = { launcher.launch(Intent(context, BrowserSignInActivity::class.java).putExtra(BrowserSignInActivity.TARGET_URL, targetUrl)) },
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
