package ai.openclaw.app.gateway

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.coroutineContext

internal data class OpenClawIdEnrollmentUiState(
  val hostname: String? = null,
  val verificationCode: String? = null,
  val commands: List<String> = emptyList(),
  val capabilities: List<String> = emptyList(),
  val waiting: Boolean = false,
  val admitted: Boolean = false,
  val error: String? = null,
)

/** Service/runtime-owned enrollment; UI only submits explicit intent and observes secret-free state. */
internal class OpenClawIdNodeController(
  private val scope: CoroutineScope,
  private val store: OpenClawIdNodeStore,
  private val discovery: OpenClawIdDiscovery = OpenClawIdDiscovery(),
) {
  private val mutableState = MutableStateFlow(OpenClawIdEnrollmentUiState())
  val state = mutableState.asStateFlow()
  private var enrollmentJob: Job? = null

  fun cancel() {
    enrollmentJob?.cancel()
    enrollmentJob = null
    mutableState.value = OpenClawIdEnrollmentUiState()
  }

  fun begin(
    link: String,
    discoveryOrigin: String,
    displayName: String,
    platform: String,
    commands: List<String>,
    capabilities: List<String>,
    isCurrent: () -> Boolean,
    onAdmitted: suspend (OpenClawIdNodeStore.Target) -> Unit,
  ) {
    val previous = enrollmentJob
    previous?.cancel()
    val enrollment =
      try {
        OpenClawIdEnrollment.parse(link, discoveryOrigin)
      } catch (_: Exception) {
        mutableState.value = OpenClawIdEnrollmentUiState(error = "Invalid invitation or Discovery address. Copy a fresh node invitation and the HTTPS Discovery origin from the owner.")
        return
      }
    val description =
      try {
        OpenClawIdEnrollmentDescription(displayName, platform, commands, capabilities)
      } catch (_: Exception) {
        enrollment.close()
        mutableState.value = OpenClawIdEnrollmentUiState(error = "This node's name or declared command surface is invalid. Review its name and enabled capabilities before trying again.")
        return
      }
    mutableState.value = OpenClawIdEnrollmentUiState(hostname = enrollment.pin.hostname, commands = commands, capabilities = capabilities, waiting = true)
    enrollmentJob =
      scope.launch {
        try {
          previous?.cancelAndJoin()
          withTimeout(3_600_000) {
            checkCurrent(isCurrent)
            val target = store.prepare(enrollment)
            val seed = store.seed(target.stableId)
            val signer =
              try {
                OpenClawIdEnrollmentSigner(seed)
              } finally {
                seed.fill(0)
              }
            signer.use {
              val prepared = enrollment.prepare(signer, description, System.currentTimeMillis() / 1_000)
              checkCurrent(isCurrent)
              mutableState.value = mutableState.value.copy(verificationCode = prepared.verificationCode)
              checkCurrent(isCurrent)
              discovery.call(target.discoveryOrigin, enrollment.mailPath, signer, prepared.mailBytes())
              var backoff = 1_000L
              while (true) {
                checkCurrent(isCurrent)
                try {
                  val response = discovery.call(target.discoveryOrigin, enrollment.descriptorPath, signer)
                  checkCurrent(isCurrent)
                  val (saved, assessment) = store.assess(target.stableId, response, System.currentTimeMillis() / 1_000)
                  if (assessment.target != null) {
                    checkCurrent(isCurrent)
                    onAdmitted(saved)
                    coroutineContext.ensureActive()
                    mutableState.value = mutableState.value.copy(waiting = false, admitted = true)
                    break
                  }
                  // A fresh, correctly pinned snapshot can temporarily precede membership propagation.
                  if (assessment.failure != "node_not_admitted" && assessment.failure != "snapshot_lagging") error("node_evidence_refused")
                } catch (error: OpenClawIdDiscoveryFailure) {
                  if (error.status !in listOf(0, 403, 429, 502, 503, 504)) throw error
                  delay(error.retryAfterMs.coerceAtLeast(backoff))
                  backoff = (backoff * 2).coerceAtMost(10_000)
                  continue
                }
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(10_000)
              }
            }
          }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
          if (isCurrent()) mutableState.value = mutableState.value.copy(waiting = false, error = "Not approved in time (denied or expired). Ask the owner for a new invitation.")
        } catch (error: CancellationException) {
          throw error
        } catch (_: Exception) {
          if (isCurrent()) mutableState.value = mutableState.value.copy(waiting = false, error = "Node enrollment could not be verified or saved. Check the Discovery address and ask the owner for a fresh invitation.")
        } finally {
          enrollment.close()
        }
      }
  }

  suspend fun refresh(stableId: String): OpenClawIdTrustTarget {
    val target = store.target(stableId) ?: error("node_target_missing")
    check(target.admitted) { "node_not_enrolled" }
    val seed = store.seed(stableId)
    val signer =
      try {
        OpenClawIdEnrollmentSigner(seed)
      } finally {
        seed.fill(0)
      }
    signer.use {
      val response =
        try {
          discovery.call(target.discoveryOrigin, target.descriptorPath, signer)
        } catch (error: OpenClawIdDiscoveryFailure) {
          if (error.status == 403) throw OpenClawIdRemovedException()
          throw error
        }
      coroutineContext.ensureActive()
      val (_, assessment) = store.assess(stableId, response, System.currentTimeMillis() / 1_000)
      return assessment.target ?: if (assessment.failure == "node_not_admitted") throw OpenClawIdRemovedException() else error("node_evidence_refused")
    }
  }

  private suspend fun checkCurrent(isCurrent: () -> Boolean) {
    coroutineContext.ensureActive()
    if (!isCurrent()) throw CancellationException("Node enrollment retired")
  }
}
