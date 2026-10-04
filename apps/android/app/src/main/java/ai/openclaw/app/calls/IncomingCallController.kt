package ai.openclaw.app.calls

import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewaySession
import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.os.Build
import android.os.Bundle
import android.os.OutcomeReceiver
import android.telecom.CallAudioState
import android.telecom.CallEndpoint
import android.telecom.CallEndpointException
import android.telecom.Connection
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** One main-thread owner; Telecom, node invocations, notification actions and UI only submit intent. */
internal class IncomingCallController(
  private val context: Context,
  private val scope: CoroutineScope,
  private val prefs: SecurePrefs,
  private val gatewayId: () -> String?,
  private val captureAuthority: () -> (() -> Boolean)?,
  private val isBusy: () -> Boolean,
  private val startAudio: suspend (String, String, Boolean) -> Unit,
  private val stopAudio: (String) -> Unit,
  private val setMuted: (Boolean) -> Unit,
  private val captureRecoveryAuthority: () -> (() -> Boolean)? = captureAuthority,
) {
  companion object {
    const val CHANNEL_ID = "openclaw_incoming_calls"
    const val NOTIFICATION_ID = 7321
    const val CALL_ID = "callId"
    const val ACTION = "callAction"

    fun accountHandle(context: Context) = PhoneAccountHandle(ComponentName(context, IncomingCallConnectionService::class.java), "openclaw-data-calls")

    @Suppress("DEPRECATION") // ConnectionService supports API 31+ devices; API 37 deprecates the capability constant.
    fun registerAccount(context: Context) {
      context.getSystemService(TelecomManager::class.java).registerPhoneAccount(
        PhoneAccount
          .builder(accountHandle(context), "OpenClaw data calls")
          .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
          .setSupportedUriSchemes(listOf("openclaw"))
          .build(),
      )
    }
  }

  private val _state = MutableStateFlow<IncomingCallState?>(null)
  val state: StateFlow<IncomingCallState?> = _state
  private var connection: Connection? = null
  private var expiryJob: Job? = null
  private var audioJob: Job? = null
  private var recoveryDeadlineJob: Job? = null
  private var recovering = false
  private var recoveryAttempt = 0
  private var audioGeneration = 0L
  private var recoveryAuthority: (() -> Boolean)? = null
  private var foregroundService: IncomingCallForegroundService? = null
  private var authority: (() -> Boolean)? = null
  private val _muted = MutableStateFlow(false)
  val muted: StateFlow<Boolean> = _muted
  private var localMuted = false
  private var platformMuted = false
  private val _audioRoutes = MutableStateFlow<List<Pair<String, String>>>(emptyList())
  val audioRoutes: StateFlow<List<Pair<String, String>>> = _audioRoutes
  private val _audioOutput = MutableStateFlow("System audio")
  val audioOutput: StateFlow<String> = _audioOutput
  private var endpoints: List<CallEndpoint> = emptyList()
  private var currentRouteIsEarpiece = false
  private val proximity = IncomingCallProximity(context, scope)
  private val reconnectTone = IncomingCallReconnectTone(scope)
  private val completed = LinkedHashMap<String, IncomingCallState>()
  private val notificationManager = context.getSystemService(NotificationManager::class.java)

  suspend fun invoke(
    command: String,
    paramsJson: String?,
  ): GatewaySession.InvokeResult =
    withContext(Dispatchers.Main.immediate) {
      try {
        val params = paramsJson?.let { Json.parseToJsonElement(it) as? JsonObject } ?: JsonObject(emptyMap())
        val id = (params[CALL_ID] as? JsonPrimitive)?.contentOrNull
        when (command) {
          "talk.incoming" -> {
            fun text(key: String) = (params[key] as? JsonPrimitive)?.contentOrNull ?: error("Missing $key")
            receive(IncomingCallInvite(text(CALL_ID), text("sessionKey"), text("callerName"), text("topic"), (params["expiresAtMs"] as? JsonPrimitive)?.longOrNull ?: error("Missing expiresAtMs")))
          }

          "talk.endCall" -> {
            require(!id.isNullOrBlank()) { "callId is required" }
            val call = find(id) ?: error("Unknown callId")
            require(call.gatewayId == gatewayId()) { "Call belongs to another Gateway connection" }
            end(id)
            result(find(id))
          }

          "talk.callStatus" -> {
            result(if (id == null) _state.value else find(id), id)
          }

          else -> {
            error("Unknown call command")
          }
        }
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        GatewaySession.InvokeResult.error("CALL_UNAVAILABLE", error.message?.take(240) ?: "Call unavailable")
      }
    }

  private fun receive(invite: IncomingCallInvite): GatewaySession.InvokeResult {
    val owner = gatewayId() ?: error("Gateway must be connected for data calls")
    val currentAuthority = captureAuthority() ?: error("Gateway connection is changing")
    val currentRecoveryAuthority = captureRecoveryAuthority() ?: error("Gateway connection is changing")
    find(invite.callId)?.let {
      require(it.gatewayId == owner && it.invite == invite) { "callId cannot be reused for a different invitation" }
      return result(it)
    }
    invite.validate(System.currentTimeMillis())
    require(prefs.isIncomingCallAllowed(owner)) { "Enable Incoming data calls in Voice settings" }
    require(hasPermission(Manifest.permission.RECORD_AUDIO)) { "Grant microphone permission in Voice settings" }
    require(NotificationManagerCompat.from(context).areNotificationsEnabled()) { "Enable OpenClaw notifications" }
    ensureNotificationChannel()
    require(notificationManager.getNotificationChannel(CHANNEL_ID)?.importance != NotificationManager.IMPORTANCE_NONE) { "Enable the Incoming data calls notification channel in Android settings" }
    require(_state.value?.status?.isTerminal != false && !isBusy()) { "Another audio capture or call is active" }
    val telecom = context.getSystemService(TelecomManager::class.java)
    registerAccount(context)
    require(telecom.isIncomingCallPermitted(accountHandle(context))) { "Android cannot accept another call now" }
    // Persist only IDs/expiry, never topic/session content; prevents a late retry ringing after process death.
    require(prefs.consumeIncomingCallId(invite.callId, invite.expiresAtMs)) { "Invitation already handled or replay ledger full" }
    require(currentAuthority() && currentRecoveryAuthority()) { "Gateway connection is changing" }
    authority = currentAuthority
    recoveryAuthority = currentRecoveryAuthority
    localMuted = false
    platformMuted = false
    updateMute()
    _state.value = IncomingCallState(invite, owner)
    expiryJob?.cancel()
    expiryJob =
      scope.launch(Dispatchers.Main.immediate) {
        delay((invite.expiresAtMs - System.currentTimeMillis()).coerceAtLeast(1))
        if (_state.value?.invite?.callId == invite.callId && _state.value?.status == IncomingCallStatus.Ringing) finish(IncomingCallStatus.Missed)
      }
    try {
      telecom.addNewIncomingCall(accountHandle(context), Bundle().apply { putString(CALL_ID, invite.callId) })
    } catch (error: Exception) {
      finish(IncomingCallStatus.Error, "Android could not present this call")
      throw error
    }
    return result(_state.value)
  }

  private fun find(id: String) = _state.value?.takeIf { it.invite.callId == id } ?: completed[id]

  private fun isCurrent(id: String): Boolean {
    val call = _state.value ?: return false
    return hasRecoveryAuthority(id) && call.gatewayId == gatewayId() && authority?.invoke() == true
  }

  private fun hasRecoveryAuthority(id: String): Boolean {
    val call = _state.value ?: return false
    return call.invite.callId == id && !call.status.isTerminal && prefs.isIncomingCallAllowed(call.gatewayId) && recoveryAuthority?.invoke() == true
  }

  private fun canControl(id: String): Boolean = if (recovering) hasRecoveryAuthority(id) else isCurrent(id)

  fun attachConnection(
    id: String,
    candidate: Connection,
  ): Boolean {
    if (!isCurrent(id) || _state.value?.status != IncomingCallStatus.Ringing || connection != null) return false
    connection = candidate
    return true
  }

  fun showIncomingUi(id: String) {
    if (isCurrent(id)) showNotification()
  }

  fun toggleMute(id: String) {
    if (!canControl(id)) return
    if (platformMuted) {
      _state.value = _state.value?.copy(detail = "Use Android call controls to turn off system mute")
      return
    }
    localMuted = !localMuted
    updateMute()
  }

  fun platformMuteChanged(
    id: String,
    muted: Boolean,
  ) {
    if (!canControl(id)) return
    platformMuted = muted
    if (!muted && _state.value?.detail == "Use Android call controls to turn off system mute") _state.value = _state.value?.copy(detail = null)
    updateMute()
  }

  private fun updateMute() {
    _muted.value = localMuted || platformMuted
    setMuted(_muted.value)
  }

  @RequiresApi(34)
  fun availableEndpointsChanged(
    id: String,
    available: List<CallEndpoint>,
  ) {
    if (!canControl(id)) return
    endpoints = available
    _audioRoutes.value = available.map { it.identifier.toString() to it.endpointName.toString() }
  }

  @RequiresApi(34)
  fun currentEndpointChanged(
    id: String,
    endpoint: CallEndpoint,
  ) {
    if (!canControl(id)) return
    _audioOutput.value = endpoint.endpointName.toString()
    currentRouteIsEarpiece = endpoint.endpointType == CallEndpoint.TYPE_EARPIECE
    updateProximity()
  }

  @Suppress("DEPRECATION") // CallAudioState is the supported route surface on API 31–33.
  fun legacyAudioStateChanged(
    id: String,
    audio: CallAudioState,
  ) {
    if (!canControl(id) || Build.VERSION.SDK_INT >= 34) return
    platformMuteChanged(id, audio.isMuted)
    _audioRoutes.value =
      listOf(
        CallAudioState.ROUTE_EARPIECE to "Earpiece",
        CallAudioState.ROUTE_SPEAKER to "Speaker",
        CallAudioState.ROUTE_BLUETOOTH to "Bluetooth",
        CallAudioState.ROUTE_WIRED_HEADSET to "Wired headset",
      ).filter { (route, _) -> audio.supportedRouteMask and route != 0 }.map { it.first.toString() to it.second }
    _audioOutput.value = _audioRoutes.value.firstOrNull { it.first == audio.route.toString() }?.second ?: "System audio"
    currentRouteIsEarpiece = audio.route == CallAudioState.ROUTE_EARPIECE
    updateProximity()
  }

  private fun updateProximity() {
    val call = _state.value
    proximity.setEarpieceCallActive(
      currentRouteIsEarpiece && call != null &&
        (call.status == IncomingCallStatus.Connecting || call.status == IncomingCallStatus.Active) &&
        canControl(call.invite.callId),
    )
  }

  @Suppress("DEPRECATION") // Legacy devices route through Connection.setAudioRoute.
  fun selectAudioRoute(
    id: String,
    route: String,
  ) {
    if (!canControl(id)) return
    val current = connection ?: return
    if (Build.VERSION.SDK_INT >= 34) {
      val endpoint = endpoints.firstOrNull { it.identifier.toString() == route } ?: return
      current.requestCallEndpointChange(
        endpoint,
        context.mainExecutor,
        object : OutcomeReceiver<Void, CallEndpointException> {
          override fun onResult(result: Void?) = Unit

          override fun onError(error: CallEndpointException) {
            if (canControl(id)) _state.value = _state.value?.copy(detail = "Audio route unavailable; choose another output")
          }
        },
      )
    } else if (_audioRoutes.value.any { it.first == route }) {
      route.toIntOrNull()?.let(current::setAudioRoute)
    }
  }

  fun answer(id: String) {
    val call = _state.value ?: return
    if (!isCurrent(id) || call.status != IncomingCallStatus.Ringing) return
    if (System.currentTimeMillis() >= call.invite.expiresAtMs) {
      finish(IncomingCallStatus.Missed)
      return
    }
    if (!hasPermission(Manifest.permission.RECORD_AUDIO) || isBusy()) {
      finish(IncomingCallStatus.Error, "Microphone unavailable; check Voice settings")
      return
    }
    expiryJob?.cancel()
    _state.value = transitionIncomingCall(call, IncomingCallStatus.Connecting)
    updateProximity()
    // Stop the repeating alert at Answer, before asynchronous microphone-service startup.
    notificationManager.cancel(NOTIFICATION_ID)
    connection?.setActive()
    expiryJob =
      scope.launch(Dispatchers.Main.immediate) {
        delay(5_000)
        if (_state.value?.invite?.callId == id && _state.value?.status == IncomingCallStatus.Connecting && foregroundService == null) {
          finish(IncomingCallStatus.Error, "Android did not start the call service")
        }
      }
    try {
      ContextCompat.startForegroundService(context, Intent(context, IncomingCallForegroundService::class.java).putExtra(CALL_ID, id))
    } catch (error: Exception) {
      finish(IncomingCallStatus.Error, "Android could not start the call; open OpenClaw and try again")
    }
  }

  internal fun foregroundServiceReady(
    id: String,
    service: IncomingCallForegroundService,
  ): Boolean {
    val call = _state.value ?: return false
    if (!canControl(id) || call.status != IncomingCallStatus.Connecting || foregroundService != null) return false
    foregroundService = service
    expiryJob?.cancel()
    try {
      showNotification()
    } catch (error: Exception) {
      finish(IncomingCallStatus.Error, "Android could not keep the call active")
      return false
    }
    if (recovering) {
      reconnectTone.start()
      startRecoveryAttempt()
    } else {
      val generation = ++audioGeneration
      audioJob =
        scope.launch(Dispatchers.Main.immediate, start = CoroutineStart.LAZY) {
          try {
            // Answer is the sole microphone-start boundary; reconnects retain that accepted call.
            startAudio(id, call.invite.sessionKey, false)
            if (generation != audioGeneration) return@launch
            if (!isCurrent(id)) {
              transportInterrupted()
              return@launch
            }
            audioConnected()
          } catch (_: GatewayRequestNotEnqueued) {
            if (generation == audioGeneration) transportInterrupted()
          } catch (error: TimeoutCancellationException) {
            if (generation == audioGeneration && isCurrent(id)) finish(IncomingCallStatus.Error, "Live voice connection timed out")
          } catch (error: CancellationException) {
            throw error
          } catch (error: Exception) {
            if (generation == audioGeneration) finish(IncomingCallStatus.Error, voiceFailureDetail(error.message))
          }
        }
      audioJob?.start()
    }
    return true
  }

  /** Transient network loss keeps only the already-answered call, never a microphone lease. */
  fun transportInterrupted() {
    val interruptedId = _state.value?.invite?.callId ?: return
    scope.launch(Dispatchers.Main.immediate) {
      val call = _state.value ?: return@launch
      if (call.invite.callId != interruptedId || call.status.isTerminal) return@launch
      if (!hasRecoveryAuthority(call.invite.callId) || call.status == IncomingCallStatus.Ringing) {
        finish(IncomingCallStatus.Ended, "Gateway connection closed")
        return@launch
      }
      ++audioGeneration
      audioJob?.cancel()
      audioJob = null
      authority = null
      stopAudio(call.invite.callId)
      if (!recovering) {
        recovering = true
        recoveryAttempt = 0
        // Independent of startup/retry cancellation: flapping cannot extend this deadline.
        recoveryDeadlineJob =
          scope.launch(Dispatchers.Main.immediate) {
            delay(30_000)
            if (recovering && _state.value?.invite?.callId == call.invite.callId) {
              finish(IncomingCallStatus.Error, "Live voice connection timed out")
            }
          }
      }
      _state.value = transitionIncomingCall(call, IncomingCallStatus.Connecting)
      updateProximity()
      if (foregroundService != null) {
        try {
          showNotification()
        } catch (_: Exception) {
          finish(IncomingCallStatus.Error, "Android could not keep the call active")
          return@launch
        }
        reconnectTone.start()
      }
      startRecoveryAttempt()
    }
  }

  fun transportConnected() {
    scope.launch(Dispatchers.Main.immediate) {
      if (recovering) startRecoveryAttempt()
    }
  }

  private fun startRecoveryAttempt() {
    if (!recovering || foregroundService == null || audioJob?.isActive == true) return
    val call = _state.value ?: return
    val id = call.invite.callId
    val generation = ++audioGeneration
    audioJob =
      scope.launch(Dispatchers.Main.immediate, start = CoroutineStart.LAZY) {
        while (recovering && generation == audioGeneration) {
          val retryDelay =
            when (recoveryAttempt++) {
              0 -> 1_000L
              1 -> 2_000L
              else -> 4_000L
            }
          delay(retryDelay)
          if (generation != audioGeneration) return@launch
          if (!hasRecoveryAuthority(id)) {
            finish(IncomingCallStatus.Ended, "Gateway connection closed")
            return@launch
          }
          if (!hasPermission(Manifest.permission.RECORD_AUDIO)) {
            finish(IncomingCallStatus.Error, "Microphone permission required")
            return@launch
          }
          if (call.gatewayId != gatewayId() || isBusy()) continue
          val freshAuthority = captureAuthority() ?: continue
          if (!freshAuthority()) continue
          authority = freshAuthority
          try {
            updateMute()
            reconnectTone.stop()
            startAudio(id, call.invite.sessionKey, true)
            // Never let an old completion stop a newer attempt sharing the same call id.
            if (generation != audioGeneration) return@launch
            if (!isCurrent(id)) {
              stopAudio(id)
              reconnectTone.start()
              continue
            }
            audioConnected()
            return@launch
          } catch (_: GatewayRequestNotEnqueued) {
            // Talk classifies transport failures before readiness observers resume.
          } catch (error: CancellationException) {
            if (error !is TimeoutCancellationException) throw error
          } catch (error: Exception) {
            if (generation == audioGeneration) finish(IncomingCallStatus.Error, voiceFailureDetail(error.message))
            return@launch
          }
          if (generation != audioGeneration) return@launch
          stopAudio(id)
          reconnectTone.start()
        }
      }
    audioJob?.start()
  }

  private fun audioConnected() {
    reconnectTone.stop()
    recovering = false
    recoveryAttempt = 0
    recoveryDeadlineJob?.cancel()
    recoveryDeadlineJob = null
    _state.value = transitionIncomingCall(_state.value ?: return, IncomingCallStatus.Active)
    try {
      updateProximity()
      connection?.setActive()
      showNotification()
    } catch (_: Exception) {
      finish(IncomingCallStatus.Error, "Android could not keep the call active")
    }
  }

  internal fun ownsForegroundService(service: IncomingCallForegroundService): Boolean = foregroundService === service && _state.value?.status?.isTerminal == false

  internal fun foregroundServiceDestroyed(service: IncomingCallForegroundService) {
    if (foregroundService !== service) return
    foregroundService = null
    if (_state.value?.status?.isTerminal == false) finish(IncomingCallStatus.Ended, "Android stopped the call service")
  }

  fun decline(id: String) {
    if (isCurrent(id) && _state.value?.status == IncomingCallStatus.Ringing) finish(IncomingCallStatus.Declined)
  }

  fun end(id: String) {
    if (_state.value?.invite?.callId == id && _state.value?.status?.isTerminal == false) finish(IncomingCallStatus.Ended)
  }

  /** A relay completion is not a Gateway disconnect; only the capture owner's failure is an error. */
  internal fun audioStopped(
    id: String,
    failureDetail: String?,
  ) {
    val call = _state.value ?: return
    if (call.invite.callId != id || call.status == IncomingCallStatus.Ringing || call.status.isTerminal) return
    if (failureDetail == null) {
      finish(IncomingCallStatus.Ended)
    } else {
      finish(IncomingCallStatus.Error, voiceFailureDetail(failureDetail))
    }
  }

  private fun voiceFailureDetail(detail: String?): String = detail?.trim()?.takeIf { it.isNotEmpty() }?.take(240) ?: "Live voice could not connect. Check Gateway Talk configuration."

  fun connectionFailed(id: String) {
    if (isCurrent(id)) finish(IncomingCallStatus.Error, "Android rejected the incoming call")
  }

  fun invalidate() {
    val invalidated = _state.value ?: return
    scope.launch(Dispatchers.Main.immediate) {
      if (_state.value?.invite?.callId == invalidated.invite.callId && _state.value?.status?.isTerminal == false) finish(IncomingCallStatus.Ended, "Gateway connection closed")
      completed.clear()
    }
  }

  private fun finish(
    status: IncomingCallStatus,
    detail: String? = null,
  ) {
    val call = _state.value ?: return
    if (call.status.isTerminal) return
    reconnectTone.stop()
    currentRouteIsEarpiece = false
    proximity.setEarpieceCallActive(false)
    expiryJob?.cancel()
    ++audioGeneration
    audioJob?.cancel()
    audioJob = null
    recovering = false
    recoveryDeadlineJob?.cancel()
    recoveryDeadlineJob = null
    stopAudio(call.invite.callId)
    val ended = transitionIncomingCall(call, status, detail)
    _state.value = ended
    completed[call.invite.callId] = ended
    while (completed.size > 64) completed.remove(completed.keys.first())
    connection?.setDisconnected(DisconnectCause(if (status == IncomingCallStatus.Declined) DisconnectCause.REJECTED else DisconnectCause.LOCAL))
    connection?.destroy()
    connection = null
    authority = null
    recoveryAuthority = null
    endpoints = emptyList()
    _audioRoutes.value = emptyList()
    _audioOutput.value = "System audio"
    val service = foregroundService
    foregroundService = null
    service?.stopCall()
    notificationManager.cancel(NOTIFICATION_ID)
  }

  private fun hasPermission(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  private fun result(
    call: IncomingCallState?,
    requestedId: String? = null,
  ): GatewaySession.InvokeResult {
    val visible = call?.takeIf { it.gatewayId == gatewayId() }
    return GatewaySession.InvokeResult.ok(
      buildJsonObject {
        if (visible != null) {
          put("callId", visible.invite.callId)
          put("sessionKey", visible.invite.sessionKey)
          put("status", visible.status.name.lowercase())
          put("expiresAtMs", visible.invite.expiresAtMs)
          visible.detail?.let { detail -> put("detail", detail) }
        } else {
          requestedId?.let { put("callId", it) }
          put("status", if (requestedId == null) "idle" else "unknown")
        }
      }.toString(),
    )
  }

  private fun actionIntent(
    call: IncomingCallState,
    action: String,
  ): PendingIntent =
    PendingIntent.getActivity(
      context,
      0,
      Intent(context, IncomingCallActivity::class.java)
        .setData("openclaw-call://${call.invite.callId}/$action".toUri())
        .putExtra(CALL_ID, call.invite.callId)
        .putExtra(ACTION, action)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  private fun showNotification() {
    val call = _state.value ?: return
    val ringing = call.status == IncomingCallStatus.Ringing
    ensureNotificationChannel()
    val person =
      Person
        .Builder()
        .setName(call.invite.callerName)
        .setImportant(true)
        .build()
    val end = actionIntent(call, if (ringing) "decline" else "end")
    val open = actionIntent(call, "show")
    val builder =
      NotificationCompat
        .Builder(context, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.sym_call_incoming)
        .setContentTitle(call.invite.callerName)
        .setContentText(if (ringing) "Incoming OpenClaw data call" else call.status.name)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setOngoing(true)
        .setOnlyAlertOnce(!ringing)
        .setSilent(!ringing)
        .setContentIntent(open)
        .setStyle(if (ringing) NotificationCompat.CallStyle.forIncomingCall(person, end, actionIntent(call, "answer")) else NotificationCompat.CallStyle.forOngoingCall(person, end))
    // Android decides whether to show the full-screen UI or a heads-up alert from user settings.
    if (ringing) builder.setFullScreenIntent(open, true)
    val notification = builder.build()
    // Let Android loop the channel's ringtone while honoring its volume, DND and silence controls.
    if (ringing) notification.flags = notification.flags or Notification.FLAG_INSISTENT
    if (ringing) notificationManager.notify(NOTIFICATION_ID, notification) else foregroundService?.publish(notification)
  }

  private fun ensureNotificationChannel() {
    notificationManager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Incoming data calls", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Calls from your connected OpenClaw Gateway"
        setSound(android.provider.Settings.System.DEFAULT_RINGTONE_URI, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build())
        enableVibration(true)
        lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
      },
    )
  }
}
