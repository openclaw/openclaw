package ai.openclaw.iroh

import android.content.Context

/** Call from Application.onCreate before any endpoint is bound. */
object OpenClawIrohAndroid {
    init { System.loadLibrary("openclaw_iroh_ffi") }

    fun install(context: Context) = installNative(context.applicationContext)

    @JvmStatic private external fun installNative(application: Context)
}
