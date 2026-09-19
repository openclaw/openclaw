package ai.openclaw.app.auto

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.NodeApp
import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

class OpenClawCarAppService : CarAppService() {
  override fun createHostValidator(): HostValidator {
    if (BuildConfig.DEBUG) {
      return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
    }
    return HostValidator.Builder(applicationContext)
      .addAllowedHosts(ai.openclaw.app.R.array.hosts_allowlist)
      .build()
  }

  override fun onCreateSession(): Session {
    val app = application as NodeApp
    return OpenClawCarSession(app)
  }
}
