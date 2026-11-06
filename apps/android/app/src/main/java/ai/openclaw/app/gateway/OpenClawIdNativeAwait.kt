package ai.openclaw.app.gateway

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext

/**
 * UniFFI 0.31.2 lowers owned handles/buffers before its Kotlin continuation runs.
 * Cancelling that generated await can discard a lowered result without freeing it.
 * Let Rust cancel the operation, but always drain the generated await and retain
 * any returned resource inside the shield until the caller has accepted ownership.
 */
internal suspend fun <T> awaitOpenClawIdNative(
  cancel: suspend () -> Unit,
  discard: suspend (T) -> Unit = {},
  operation: suspend () -> T,
): T {
  var delivered: Result<T>? = null
  try {
    return coroutineScope {
      val caller = coroutineContext
      val cancellation =
        launch(start = CoroutineStart.UNDISPATCHED) {
          try {
            awaitCancellation()
          } finally {
            if (!caller[kotlinx.coroutines.Job]!!.isActive) {
              withContext(NonCancellable) { runCatching { cancel() } }
            }
          }
        }
      try {
        withContext(NonCancellable) {
          operation().also { delivered = Result.success(it) }
        }
        caller.ensureActive()
        checkNotNull(delivered).getOrThrow()
      } finally {
        withContext(NonCancellable) { cancellation.cancelAndJoin() }
      }
    }
  } catch (error: Throwable) {
    withContext(NonCancellable) { delivered?.onSuccess { discard(it) } }
    coroutineContext.ensureActive()
    throw error
  }
}
