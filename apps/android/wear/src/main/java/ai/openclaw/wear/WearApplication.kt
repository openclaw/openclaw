package ai.openclaw.wear

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.util.concurrent.atomic.AtomicInteger

class WearApplication : Application() {
  internal val processScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  internal val proxyClient: WearProxyClient by lazy {
    WearProxyClient.create(context = this)
  }

  internal val gatewayRepository: WearGatewayRepository by lazy {
    WearGatewayRepository(proxyClient)
  }

  private val visibleActivities = AtomicInteger()

  internal fun onActivityStarted() {
    visibleActivities.incrementAndGet()
  }

  internal fun onActivityStopped() {
    visibleActivities.updateAndGet { current -> (current - 1).coerceAtLeast(0) }
  }

  internal fun isActivityVisible(): Boolean = visibleActivities.get() > 0
}
