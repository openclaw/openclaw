package ai.openclaw.android

import android.app.Application
import android.os.StrictMode
import android.util.Log
import java.security.Security

class NodeApp : Application() {
  val runtime: NodeRuntime by lazy { NodeRuntime(this) }

  override fun onCreate() {
    super.onCreate()
    // Register Bouncy Castle as highest-priority provider for Ed25519 support
    try {
      val bcProvider = Class.forName("org.bouncycastle.jce.provider.BouncyCastleProvider")
        .getDeclaredConstructor().newInstance() as java.security.Provider
      Security.removeProvider("BC")
      Security.insertProviderAt(bcProvider, 1)
    } catch (it: Throwable) {
      Log.e("NodeApp", "Failed to register Bouncy Castle provider", it)
    }
    if (BuildConfig.DEBUG) {
      StrictMode.setThreadPolicy(
        StrictMode.ThreadPolicy.Builder()
          .detectAll()
          .penaltyLog()
          .build(),
      )
      StrictMode.setVmPolicy(
        StrictMode.VmPolicy.Builder()
          .detectAll()
          .penaltyLog()
          .build(),
      )
    }
  }
}
