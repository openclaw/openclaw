package ai.openclaw.app.ui

import ai.openclaw.app.R
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import java.util.concurrent.atomic.AtomicInteger

private val proxyLobsterVisits = AtomicInteger()
private val proxyLobsterCharacters =
  intArrayOf(
    R.drawable.proxy_lobster_blue,
    R.drawable.proxy_lobster_gold,
    R.drawable.proxy_lobster_pixel,
    R.drawable.proxy_lobster_crimson,
  )

/** Decorative visitor rotates only when the credential screen opens, never on auth changes. */
@Composable
internal fun ProxyLobsterMascot() {
  val character = remember { proxyLobsterCharacters[Math.floorMod(proxyLobsterVisits.getAndIncrement(), proxyLobsterCharacters.size)] }
  Image(painterResource(character), contentDescription = null, modifier = Modifier.size(48.dp))
}
