package ai.openclaw.app.tools

import android.os.Build

abstract class Features {
  abstract val has: Boolean

  object Motion : Features() {
    override val has: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
  }
}