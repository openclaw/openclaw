package ai.openclaw.wear

import android.app.Activity
import android.app.RemoteInput
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.input.RemoteInputIntentHelper
import kotlinx.coroutines.delay

@Composable
internal fun WearConnectionHost(
  app: WearApplication,
  initialPage: WearHomePage,
  navigationRequest: WearNavigationRequest?,
  onNavigationRequestHandled: (Int) -> Unit,
) {
  val runtime = app.directRuntime
  val state by runtime.state.collectAsState()
  var manage by remember { mutableStateOf(false) }
  if (!manage && !state.connectionManagementRequired && state.selected == null && !state.busy) {
    // Leaving Phone Proxy disposes its ViewModel scope and microphone owner.
    val viewModels = remember { ViewModelStore() }
    val viewModel =
      remember(viewModels) {
        ViewModelProvider(viewModels, ViewModelProvider.AndroidViewModelFactory.getInstance(app))[WearViewModel::class.java]
      }
    DisposableEffect(viewModels) { onDispose { viewModels.clear() } }
    OpenClawWearApp(
      viewModel,
      remember { WearSettingsStore(app) },
      remember { WearReplySpeaker(app) },
      initialPage,
      navigationRequest,
      onNavigationRequestHandled,
      onManageConnection = { manage = true },
    )
  } else {
    OpenClawWearTheme(themeMode = remember { WearSettingsStore(app).read().themeMode }) {
      AppScaffold {
        WearDirectContent(runtime, state, manage || state.connectionManagementRequired, onManage = { manage = it })
      }
    }
    navigationRequest?.let { request ->
      LaunchedEffect(request.id) { onNavigationRequestHandled(request.id) }
    }
  }
}

@Composable
private fun WearDirectContent(
  runtime: WearDirectRuntime,
  state: WearDirectState,
  manage: Boolean,
  onManage: (Boolean) -> Unit,
) {
  var page by remember { mutableStateOf("chat") }
  var review by remember { mutableStateOf<WearApproval?>(null) }
  var confirmation by remember { mutableStateOf<String?>(null) }
  var forget by remember { mutableStateOf<String?>(null) }
  var inputOwner by remember { mutableStateOf<WearInputOwner?>(null) }
  var enterSetup by remember { mutableStateOf(false) }
  var setupCode by remember { mutableStateOf("") }
  var now by remember { mutableStateOf(System.currentTimeMillis()) }
  LaunchedEffect(review?.id) {
    while (review != null) {
      now = System.currentTimeMillis()
      delay(1000)
    }
  }
  LaunchedEffect(state.selected?.stableId, state.sessionKey) {
    review = null
    confirmation = null
  }
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  DisposableEffect(lifecycle) {
    val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) setupCode = "" }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer) }
  }
  val messageLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val message =
        result.data
          ?.let(RemoteInput::getResultsFromIntent)
          ?.getCharSequence("message")
          ?.toString()
      if (result.resultCode == Activity.RESULT_OK && message != null) inputOwner?.let { runtime.send(message, it) }
      inputOwner = null
    }

  fun input(
    key: String,
    title: String,
  ): Intent {
    val remote = RemoteInput.Builder(key).setLabel(title).build()
    return RemoteInputIntentHelper.createActionRemoteInputIntent().also {
      RemoteInputIntentHelper.putRemoteInputsExtra(it, listOf(remote))
      RemoteInputIntentHelper.putTitleExtra(it, title)
    }
  }
  BackHandler(manage || page != "chat" || review != null) {
    when {
      state.connectionManagementRequired -> {
        runtime.cancelSetup()
        onManage(false)
      }

      confirmation != null -> {
        confirmation = null
      }

      review != null -> {
        review = null
      }

      page != "chat" -> {
        page = "chat"
      }

      else -> {
        onManage(false)
      }
    }
  }
  val currentReview = review?.let { selected -> state.approvals.firstOrNull { it.id == selected.id } ?: selected }
  val title =
    when {
      manage -> stringResource(R.string.watch_connection)
      currentReview != null -> stringResource(R.string.watch_approval)
      page == "sessions" -> stringResource(R.string.watch_sessions)
      page == "approvals" -> stringResource(R.string.watch_approvals)
      else -> stringResource(R.string.chat)
    }
  val setupLabel = stringResource(R.string.watch_setup_code)
  val messageLabel = stringResource(R.string.message)
  WearPage(pageLabel = title) {
    item { DirectText(state.selected?.name ?: stringResource(R.string.watch_phone_proxy)) }
    state.error?.let { error -> item { DirectText(error) } }
    if (state.busy) item { DirectText(stringResource(R.string.watch_updating_connection)) }
    if (manage && state.trust == null) {
      item {
        SecondaryButton(setupLabel, !state.busy) {
          enterSetup = !enterSetup
          setupCode = ""
        }
      }
      if (enterSetup) {
        item {
          BasicTextField(
            value = setupCode,
            onValueChange = { if (it.length <= 16_384) setupCode = it },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            textStyle = TextStyle(color = OpenClawWearTheme.colors.text, fontSize = 14.sp),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp),
            decorationBox = { field ->
              if (setupCode.isEmpty()) Text(setupLabel)
              field()
            },
          )
        }
        item {
          SecondaryButton(stringResource(R.string.watch_connect), !state.busy && setupCode.isNotBlank()) {
            runtime.setup(setupCode)
            setupCode = ""
            enterSetup = false
            onManage(false)
          }
        }
      }
      state.gateways.forEach { gateway ->
        item {
          SecondaryButton(gateway.name, !state.busy) {
            runtime.selectGateway(gateway.stableId)
            onManage(false)
          }
        }
        item {
          SecondaryButton(stringResource(R.string.watch_forget), !state.busy) { forget = gateway.stableId }
        }
      }
      forget?.let { id ->
        item { DirectText(stringResource(R.string.watch_forget_confirmation)) }
        item {
          SecondaryButton(stringResource(R.string.watch_confirm_forget), !state.busy) {
            runtime.forget(id)
            forget = null
          }
        }
      }
      item {
        SecondaryButton(stringResource(R.string.watch_phone_proxy), !state.busy) {
          runtime.selectPhoneProxy()
          onManage(false)
        }
      }
    } else if (state.trust != null) {
      val prompt = state.trust
      item { DirectText(stringResource(R.string.watch_certificate)) }
      item { DirectText(prompt.fingerprint) }
      prompt.previous?.let { previous -> item { DirectText(stringResource(R.string.watch_previous_certificate, previous)) } }
      item { SecondaryButton(stringResource(R.string.watch_trust_certificate), true) { runtime.acceptCertificate(prompt) } }
      item { SecondaryButton(stringResource(R.string.watch_reject_certificate), true, runtime::disconnect) }
    } else if (currentReview != null) {
      val approval = currentReview
      item { DirectText(approvalTitle(approval)) }
      approval.details.forEach { detail ->
        item {
          DirectText(
            when {
              detail.label == null -> detail.value
              detail.value.isEmpty() -> stringResource(detail.label)
              else -> stringResource(detail.label, detail.value)
            },
          )
        }
      }
      approval.externalResolution?.let { external ->
        item { DirectText(stringResource(R.string.watch_approval_external_resolution, external.label)) }
      }
      approval.reviewIssue?.let { issue -> item { DirectText(stringResource(issue)) } }
      approval.sourceSessionKey?.let { item { DirectText(it) } }
      item { DirectText(approval.status) }
      val enabled = state.connected && state.approvalsReady && approval.id !in state.resolving
      approval.decisions.forEach { decision ->
        item {
          SecondaryButton(decisionLabel(decision), enabled && approval.canResolve(decision, now)) {
            confirmation = decision
          }
        }
      }
      confirmation?.let { decision ->
        item {
          SecondaryButton(stringResource(R.string.watch_confirm_decision, decisionLabel(decision)), enabled && approval.canResolve(decision, now)) {
            runtime.resolve(approval, decision)
            confirmation = null
          }
        }
      }
      if (approval.id in state.resolving) item { DirectText(stringResource(R.string.watch_approval_unconfirmed)) }
    } else if (page == "sessions") {
      state.sessions.forEach { session ->
        item {
          SecondaryButton(session.title, state.connected) {
            runtime.selectSession(session.key)
            page = "chat"
          }
        }
      }
    } else if (page == "approvals") {
      if (!state.approvalsReady) item { DirectText(stringResource(R.string.watch_approvals_unavailable)) }
      if (state.approvalsIncomplete) item { DirectText(stringResource(R.string.watch_approvals_incomplete)) }
      state.approvals.forEach { approval ->
        item { SecondaryButton("${approvalTitle(approval)}: ${approval.status}", true) { review = approval } }
      }
      if (state.approvalsReady && state.approvals.isEmpty()) item { DirectText(stringResource(R.string.watch_no_approvals)) }
    } else {
      item { DirectText(state.status) }
      item { SecondaryButton(stringResource(R.string.watch_sessions), state.connected) { page = "sessions" } }
      item { SecondaryButton(stringResource(R.string.watch_approvals), state.connected) { page = "approvals" } }
      state.messages.forEach { message -> item { MessageBubble(message) } }
      state.streamText?.let { text -> item { StreamingBubble(text) } }
      state.pendingSend?.let { pending -> item { MessageBubble(WearChatMessage(pending.key, "user", pending.message, null)) } }
      item {
        SecondaryButton(messageLabel, state.connected && state.sessionKey != null && state.pendingSend == null && !state.sending && !state.sendUnknown) {
          inputOwner = runtime.inputOwner()
          messageLauncher.launch(input("message", messageLabel))
        }
      }
      val pending = state.pendingSend
      if (pending != null && !state.sending) {
        item { DirectText(stringResource(if (state.sendUnknown) R.string.watch_message_unconfirmed else R.string.message_not_sent)) }
        item { SecondaryButton(stringResource(R.string.retry), state.connected, runtime::retrySend) }
        if (!state.sendUnknown) {
          item { SecondaryButton(stringResource(R.string.watch_discard_message), true) { runtime.discardPendingSend(pending) } }
        }
      }
      if (state.runId != null) item { SecondaryButton(stringResource(R.string.watch_stop), state.connected, runtime::abort) }
    }
    if (!manage) {
      item { SecondaryButton(stringResource(R.string.refresh), state.connected, runtime::refresh) }
      item {
        SecondaryButton(stringResource(if (state.connected) R.string.watch_disconnect else R.string.watch_reconnect), !state.busy) {
          if (state.connected) runtime.disconnect() else runtime.reconnect()
        }
      }
      item { SecondaryButton(stringResource(R.string.watch_connection), true) { onManage(true) } }
    }
  }
}

@Composable
private fun DirectText(text: String) {
  Text(text, modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp), textAlign = TextAlign.Center)
}

@Composable
private fun approvalTitle(approval: WearApproval): String = approval.title.ifEmpty { stringResource(if (approval.kind == "exec") R.string.watch_command_approval else R.string.watch_approval) }

@Composable
private fun decisionLabel(decision: String): String =
  stringResource(
    when (decision) {
      "allow-once" -> R.string.watch_allow_once
      "allow-always" -> R.string.watch_allow_always
      else -> R.string.watch_deny
    },
  )
