package ai.openclaw.android.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import ai.openclaw.android.LocationMode
import ai.openclaw.android.MainViewModel
import ai.openclaw.android.R
import java.util.Locale
import org.json.JSONObject

private enum class OnboardingStep(val index: Int, val label: String) {
  Welcome(1, "Welcome"),
  Gateway(2, "Gateway"),
  Permissions(3, "Permissions"),
  FinalCheck(4, "Connect"),
}

private enum class GatewayInputMode {
  SetupCode,
  Manual,
}

private data class ParsedGateway(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val displayUrl: String,
)

private data class SetupCodePayload(
  val url: String,
  val token: String?,
  val password: String?,
)

private val onboardingBackgroundGradient =
  listOf(
    Color(0xFFFFFFFF),
    Color(0xFFF7F8FA),
    Color(0xFFEFF1F5),
  )
private val onboardingSurface = Color(0xFFF6F7FA)
private val onboardingBorder = Color(0xFFE5E7EC)
private val onboardingBorderStrong = Color(0xFFD6DAE2)
private val onboardingText = Color(0xFF17181C)
private val onboardingTextSecondary = Color(0xFF4D5563)
private val onboardingTextTertiary = Color(0xFF8A92A2)
private val onboardingAccent = Color(0xFF1D5DD8)
private val onboardingAccentSoft = Color(0xFFECF3FF)
private val onboardingSuccess = Color(0xFF2F8C5A)
private val onboardingWarning = Color(0xFFC8841A)
private val onboardingCommandBg = Color(0xFF15171B)
private val onboardingCommandBorder = Color(0xFF2B2E35)
private val onboardingCommandAccent = Color(0xFF3FC97A)
private val onboardingCommandText = Color(0xFFE8EAEE)

private val onboardingFontFamily =
  FontFamily(
    Font(resId = R.font.manrope_400_regular, weight = FontWeight.Normal),
    Font(resId = R.font.manrope_500_medium, weight = FontWeight.Medium),
    Font(resId = R.font.manrope_600_semibold, weight = FontWeight.SemiBold),
    Font(resId = R.font.manrope_700_bold, weight = FontWeight.Bold),
  )

private val onboardingDisplayStyle =
  TextStyle(
    fontFamily = onboardingFontFamily,
    fontWeight = FontWeight.Bold,
    fontSize = 34.sp,
    lineHeight = 40.sp,
    letterSpacing = (-0.8).sp,
  )

private val onboardingTitle1Style =
  TextStyle(
    fontFamily = onboardingFontFamily,
    fontWeight = FontWeight.SemiBold,
    fontSize = 24.sp,
    lineHeight = 30.sp,
    letterSpacing = (-0.5).sp,
  )

private val onboardingHeadlineStyle =
  TextStyle(
    fontFamily = onboardingFontFamily,
    fontWeight = FontWeight.SemiBold,
    fontSize = 16.sp,
    lineHeight = 22.sp,
    letterSpacing = (-0.1).sp,
  )

private val onboardingBodyStyle =
  TextStyle(
    fontFamily = onboardingFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 15.sp,
    lineHeight = 22.sp,
  )

private val onboardingCalloutStyle =
  TextStyle(
    fontFamily = onboardingFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 14.sp,
    lineHeight = 20.sp,
  )

private val onboardingCaption1Style =
  TextStyle(
    fontFamily = onboardingFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 12.sp,
    lineHeight = 16.sp,
    letterSpacing = 0.2.sp,
  )

private val onboardingCaption2Style =
  TextStyle(
    fontFamily = onboardingFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 11.sp,
    lineHeight = 14.sp,
    letterSpacing = 0.4.sp,
  )

@Composable
fun OnboardingFlow(viewModel: MainViewModel, modifier: Modifier = Modifier) {
  val context = androidx.compose.ui.platform.LocalContext.current
  val statusText by viewModel.statusText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val serverName by viewModel.serverName.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()
  val persistedGatewayToken by viewModel.gatewayToken.collectAsState()
  val pendingTrust by viewModel.pendingGatewayTrust.collectAsState()

  var step by rememberSaveable { mutableStateOf(OnboardingStep.Welcome) }
  var setupCode by rememberSaveable { mutableStateOf("") }
  var gatewayUrl by rememberSaveable { mutableStateOf("") }
  var gatewayPassword by rememberSaveable { mutableStateOf("") }
  var gatewayInputMode by rememberSaveable { mutableStateOf(GatewayInputMode.SetupCode) }
  var manualHost by rememberSaveable { mutableStateOf("10.0.2.2") }
  var manualPort by rememberSaveable { mutableStateOf("18789") }
  var manualTls by rememberSaveable { mutableStateOf(false) }
  var gatewayError by rememberSaveable { mutableStateOf<String?>(null) }
  var attemptedConnect by rememberSaveable { mutableStateOf(false) }

  var enableDiscovery by rememberSaveable { mutableStateOf(true) }
  var enableNotifications by rememberSaveable { mutableStateOf(true) }
  var enableMicrophone by rememberSaveable { mutableStateOf(false) }
  var enableCamera by rememberSaveable { mutableStateOf(false) }
  var enableSms by rememberSaveable { mutableStateOf(false) }

  val smsAvailable =
    remember(context) {
      context.packageManager?.hasSystemFeature(PackageManager.FEATURE_TELEPHONY) == true
    }

  val selectedPermissions =
    remember(
      context,
      enableDiscovery,
      enableNotifications,
      enableMicrophone,
      enableCamera,
      enableSms,
      smsAvailable,
    ) {
      val requested = mutableListOf<String>()
      if (enableDiscovery) {
        requested += if (Build.VERSION.SDK_INT >= 33) Manifest.permission.NEARBY_WIFI_DEVICES else Manifest.permission.ACCESS_FINE_LOCATION
      }
      if (enableNotifications && Build.VERSION.SDK_INT >= 33) requested += Manifest.permission.POST_NOTIFICATIONS
      if (enableMicrophone) requested += Manifest.permission.RECORD_AUDIO
      if (enableCamera) requested += Manifest.permission.CAMERA
      if (enableSms && smsAvailable) requested += Manifest.permission.SEND_SMS
      requested.filterNot { isPermissionGranted(context, it) }
    }

  val enabledPermissionSummary =
    remember(enableDiscovery, enableNotifications, enableMicrophone, enableCamera, enableSms, smsAvailable) {
      val enabled = mutableListOf<String>()
      if (enableDiscovery) enabled += "Gateway discovery"
      if (Build.VERSION.SDK_INT >= 33 && enableNotifications) enabled += "Notifications"
      if (enableMicrophone) enabled += "Microphone"
      if (enableCamera) enabled += "Camera"
      if (smsAvailable && enableSms) enabled += "SMS"
      if (enabled.isEmpty()) "None selected" else enabled.joinToString(", ")
    }

  val permissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
      step = OnboardingStep.FinalCheck
    }

  if (pendingTrust != null) {
    val prompt = pendingTrust!!
    AlertDialog(
      onDismissRequest = { viewModel.declineGatewayTrustPrompt() },
      title = { Text("Trust this gateway?") },
      text = {
        Text(
          "First-time TLS connection.\n\nVerify this SHA-256 fingerprint before trusting:\n${prompt.fingerprintSha256}",
        )
      },
      confirmButton = {
        TextButton(onClick = { viewModel.acceptGatewayTrustPrompt() }) {
          Text("Trust and continue")
        }
      },
      dismissButton = {
        TextButton(onClick = { viewModel.declineGatewayTrustPrompt() }) {
          Text("Cancel")
        }
      },
    )
  }

  Box(
    modifier =
      modifier
        .fillMaxSize()
        .background(Brush.verticalGradient(onboardingBackgroundGradient)),
  ) {
    Column(
      modifier =
        Modifier
          .fillMaxSize()
          .imePadding()
          .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
          .navigationBarsPadding()
          .padding(horizontal = 20.dp, vertical = 12.dp),
      verticalArrangement = Arrangement.SpaceBetween,
    ) {
      Column(
        modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(20.dp),
      ) {
        Column(
          modifier = Modifier.padding(top = 12.dp),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          Text(
            "FIRST RUN",
            style = onboardingCaption1Style.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp),
            color = onboardingAccent,
          )
          Text(
            "OpenClaw\nMobile Setup",
            style = onboardingDisplayStyle.copy(lineHeight = 38.sp),
            color = onboardingText,
          )
          Text(
            "Step ${step.index} of 4",
            style = onboardingCaption1Style,
            color = onboardingAccent,
          )
        }
        StepRailWrap(current = step)

        when (step) {
          OnboardingStep.Welcome -> WelcomeStep()
          OnboardingStep.Gateway ->
            GatewayStep(
              inputMode = gatewayInputMode,
              setupCode = setupCode,
              manualHost = manualHost,
              manualPort = manualPort,
              manualTls = manualTls,
              gatewayToken = persistedGatewayToken,
              gatewayPassword = gatewayPassword,
              gatewayError = gatewayError,
              onInputModeChange = {
                gatewayInputMode = it
                gatewayError = null
              },
              onSetupCodeChange = {
                setupCode = it
                gatewayError = null
              },
              onManualHostChange = {
                manualHost = it
                gatewayError = null
              },
              onManualPortChange = {
                manualPort = it
                gatewayError = null
              },
              onManualTlsChange = { manualTls = it },
              onTokenChange = viewModel::setGatewayToken,
              onPasswordChange = { gatewayPassword = it },
            )
          OnboardingStep.Permissions ->
            PermissionsStep(
              enableDiscovery = enableDiscovery,
              enableNotifications = enableNotifications,
              enableMicrophone = enableMicrophone,
              enableCamera = enableCamera,
              enableSms = enableSms,
              smsAvailable = smsAvailable,
              context = context,
              onDiscoveryChange = { enableDiscovery = it },
              onNotificationsChange = { enableNotifications = it },
              onMicrophoneChange = { enableMicrophone = it },
              onCameraChange = { enableCamera = it },
              onSmsChange = { enableSms = it },
            )
          OnboardingStep.FinalCheck ->
            FinalStep(
              parsedGateway = parseGateway(gatewayUrl),
              statusText = statusText,
              isConnected = isConnected,
              serverName = serverName,
              remoteAddress = remoteAddress,
              attemptedConnect = attemptedConnect,
              enabledPermissions = enabledPermissionSummary,
              methodLabel = if (gatewayInputMode == GatewayInputMode.SetupCode) "Setup Code" else "Manual",
            )
        }
      }

      Spacer(Modifier.height(12.dp))

      Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        val backEnabled = step != OnboardingStep.Welcome
        Surface(
          modifier = Modifier.size(52.dp),
          shape = RoundedCornerShape(14.dp),
          color = onboardingSurface,
          border = androidx.compose.foundation.BorderStroke(1.dp, if (backEnabled) onboardingBorderStrong else onboardingBorder),
        ) {
          IconButton(
            onClick = {
              step =
                when (step) {
                  OnboardingStep.Welcome -> OnboardingStep.Welcome
                  OnboardingStep.Gateway -> OnboardingStep.Welcome
                  OnboardingStep.Permissions -> OnboardingStep.Gateway
                  OnboardingStep.FinalCheck -> OnboardingStep.Permissions
                }
            },
            enabled = backEnabled,
          ) {
            Icon(
              Icons.AutoMirrored.Filled.ArrowBack,
              contentDescription = "Back",
              tint = if (backEnabled) onboardingTextSecondary else onboardingTextTertiary,
            )
          }
        }

        when (step) {
          OnboardingStep.Welcome -> {
            Button(
              onClick = { step = OnboardingStep.Gateway },
              modifier = Modifier.weight(1f).height(52.dp),
              shape = RoundedCornerShape(14.dp),
              colors =
                ButtonDefaults.buttonColors(
                  containerColor = onboardingAccent,
                  contentColor = Color.White,
                  disabledContainerColor = onboardingAccent.copy(alpha = 0.45f),
                  disabledContentColor = Color.White,
                ),
            ) {
              Text("Next", style = onboardingHeadlineStyle.copy(fontWeight = FontWeight.Bold))
            }
          }
          OnboardingStep.Gateway -> {
            Button(
              onClick = {
                if (gatewayInputMode == GatewayInputMode.SetupCode) {
                  val parsedSetup = decodeSetupCode(setupCode)
                  if (parsedSetup == null) {
                    gatewayError = "Invalid setup code."
                    return@Button
                  }
                  val parsedGateway = parseGateway(parsedSetup.url)
                  if (parsedGateway == null) {
                    gatewayError = "Setup code has invalid gateway URL."
                    return@Button
                  }
                  gatewayUrl = parsedSetup.url
                  parsedSetup.token?.let { viewModel.setGatewayToken(it) }
                  gatewayPassword = parsedSetup.password.orEmpty()
                } else {
                  val manualUrl = composeManualGatewayUrl(manualHost, manualPort, manualTls)
                  val parsedGateway = manualUrl?.let(::parseGateway)
                  if (parsedGateway == null) {
                    gatewayError = "Manual endpoint is invalid."
                    return@Button
                  }
                  gatewayUrl = parsedGateway.displayUrl
                }
                step = OnboardingStep.Permissions
              },
              modifier = Modifier.weight(1f).height(52.dp),
              shape = RoundedCornerShape(14.dp),
              colors =
                ButtonDefaults.buttonColors(
                  containerColor = onboardingAccent,
                  contentColor = Color.White,
                  disabledContainerColor = onboardingAccent.copy(alpha = 0.45f),
                  disabledContentColor = Color.White,
                ),
            ) {
              Text("Next", style = onboardingHeadlineStyle.copy(fontWeight = FontWeight.Bold))
            }
          }
          OnboardingStep.Permissions -> {
            Button(
              onClick = {
                viewModel.setCameraEnabled(enableCamera)
                viewModel.setLocationMode(if (enableDiscovery) LocationMode.WhileUsing else LocationMode.Off)
                if (selectedPermissions.isEmpty()) {
                  step = OnboardingStep.FinalCheck
                } else {
                  permissionLauncher.launch(selectedPermissions.toTypedArray())
                }
              },
              modifier = Modifier.weight(1f).height(52.dp),
              shape = RoundedCornerShape(14.dp),
              colors =
                ButtonDefaults.buttonColors(
                  containerColor = onboardingAccent,
                  contentColor = Color.White,
                  disabledContainerColor = onboardingAccent.copy(alpha = 0.45f),
                  disabledContentColor = Color.White,
                ),
            ) {
              Text("Next", style = onboardingHeadlineStyle.copy(fontWeight = FontWeight.Bold))
            }
          }
          OnboardingStep.FinalCheck -> {
            if (isConnected) {
              Button(
                onClick = { viewModel.setOnboardingCompleted(true) },
                modifier = Modifier.weight(1f).height(52.dp),
                shape = RoundedCornerShape(14.dp),
                colors =
                  ButtonDefaults.buttonColors(
                    containerColor = onboardingAccent,
                    contentColor = Color.White,
                    disabledContainerColor = onboardingAccent.copy(alpha = 0.45f),
                    disabledContentColor = Color.White,
                  ),
              ) {
                Text("Finish", style = onboardingHeadlineStyle.copy(fontWeight = FontWeight.Bold))
              }
            } else {
              Button(
                onClick = {
                  val parsed = parseGateway(gatewayUrl)
                  if (parsed == null) {
                    step = OnboardingStep.Gateway
                    gatewayError = "Invalid gateway URL."
                    return@Button
                  }
                  val token = persistedGatewayToken.trim()
                  val password = gatewayPassword.trim()
                  attemptedConnect = true
                  viewModel.setManualEnabled(true)
                  viewModel.setManualHost(parsed.host)
                  viewModel.setManualPort(parsed.port)
                  viewModel.setManualTls(parsed.tls)
                  if (token.isNotEmpty()) {
                    viewModel.setGatewayToken(token)
                  }
                  viewModel.setGatewayPassword(password)
                  viewModel.connectManual()
                },
                modifier = Modifier.weight(1f).height(52.dp),
                shape = RoundedCornerShape(14.dp),
                colors =
                  ButtonDefaults.buttonColors(
                    containerColor = onboardingAccent,
                    contentColor = Color.White,
                    disabledContainerColor = onboardingAccent.copy(alpha = 0.45f),
                    disabledContentColor = Color.White,
                  ),
              ) {
                Text("Connect", style = onboardingHeadlineStyle.copy(fontWeight = FontWeight.Bold))
              }
            }
          }
        }
      }
    }
  }
}

@Composable
private fun StepRailWrap(current: OnboardingStep) {
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    HorizontalDivider(color = onboardingBorder)
    StepRail(current = current)
    HorizontalDivider(color = onboardingBorder)
  }
}

@Composable
private fun StepRail(current: OnboardingStep) {
  val steps = OnboardingStep.entries
  Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
    steps.forEach { step ->
      val complete = step.index < current.index
      val active = step.index == current.index
      Column(
        modifier = Modifier.weight(1f),
        verticalArrangement = Arrangement.spacedBy(4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
      ) {
        Box(
          modifier =
            Modifier
              .fillMaxWidth()
              .height(5.dp)
              .background(
                color =
                  when {
                    complete -> onboardingSuccess
                    active -> onboardingAccent
                    else -> onboardingBorder
                  },
                shape = RoundedCornerShape(999.dp),
              ),
        )
        Text(
          text = step.label,
          style = onboardingCaption2Style.copy(fontWeight = if (active) FontWeight.Bold else FontWeight.SemiBold),
          color = if (active) onboardingAccent else onboardingTextSecondary,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
  }
}

@Composable
private fun WelcomeStep() {
  StepShell(title = "What You Get") {
    Bullet("Control the gateway and operator chat from one mobile surface.")
    Bullet("Connect with setup code and recover pairing with CLI commands.")
    Bullet("Enable only the permissions and capabilities you want.")
    Bullet("Finish with a real connection check before entering the app.")
  }
}

@Composable
private fun GatewayStep(
  inputMode: GatewayInputMode,
  setupCode: String,
  manualHost: String,
  manualPort: String,
  manualTls: Boolean,
  gatewayToken: String,
  gatewayPassword: String,
  gatewayError: String?,
  onInputModeChange: (GatewayInputMode) -> Unit,
  onSetupCodeChange: (String) -> Unit,
  onManualHostChange: (String) -> Unit,
  onManualPortChange: (String) -> Unit,
  onManualTlsChange: (Boolean) -> Unit,
  onTokenChange: (String) -> Unit,
  onPasswordChange: (String) -> Unit,
) {
  val resolvedEndpoint = remember(setupCode) { decodeSetupCode(setupCode)?.url?.let { parseGateway(it)?.displayUrl } }
  val manualResolvedEndpoint = remember(manualHost, manualPort, manualTls) { composeManualGatewayUrl(manualHost, manualPort, manualTls)?.let { parseGateway(it)?.displayUrl } }

  StepShell(title = "Gateway Connection") {
    GuideBlock(title = "Get setup code + gateway URL") {
      Text("Run these on the gateway host:", style = onboardingCalloutStyle, color = onboardingTextSecondary)
      CommandBlock("openclaw qr --setup-code-only")
      CommandBlock("openclaw qr --json")
      Text(
        "`--json` prints `setupCode` and `gatewayUrl`.",
        style = onboardingCalloutStyle,
        color = onboardingTextSecondary,
      )
      Text(
        "Auto URL discovery is not wired yet. Android emulator uses `10.0.2.2`; real devices need LAN/Tailscale host.",
        style = onboardingCalloutStyle,
        color = onboardingTextSecondary,
      )
    }
    GatewayModeToggle(inputMode = inputMode, onInputModeChange = onInputModeChange)

    if (inputMode == GatewayInputMode.SetupCode) {
      Text("SETUP CODE", style = onboardingCaption1Style.copy(letterSpacing = 0.9.sp), color = onboardingTextSecondary)
      OutlinedTextField(
        value = setupCode,
        onValueChange = onSetupCodeChange,
        placeholder = { Text("Paste code from `openclaw qr --setup-code-only`", color = onboardingTextTertiary, style = onboardingBodyStyle) },
        modifier = Modifier.fillMaxWidth(),
        minLines = 3,
        maxLines = 5,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
        textStyle = onboardingBodyStyle.copy(fontFamily = FontFamily.Monospace, color = onboardingText),
        shape = RoundedCornerShape(14.dp),
        colors =
          OutlinedTextFieldDefaults.colors(
            focusedContainerColor = onboardingSurface,
            unfocusedContainerColor = onboardingSurface,
            focusedBorderColor = onboardingAccent,
            unfocusedBorderColor = onboardingBorder,
            focusedTextColor = onboardingText,
            unfocusedTextColor = onboardingText,
            cursorColor = onboardingAccent,
          ),
      )
      if (!resolvedEndpoint.isNullOrBlank()) {
        ResolvedEndpoint(endpoint = resolvedEndpoint)
      }
    } else {
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        QuickFillChip(label = "Android Emulator", onClick = {
          onManualHostChange("10.0.2.2")
          onManualPortChange("18789")
          onManualTlsChange(false)
        })
        QuickFillChip(label = "Localhost", onClick = {
          onManualHostChange("127.0.0.1")
          onManualPortChange("18789")
          onManualTlsChange(false)
        })
      }

      Text("HOST", style = onboardingCaption1Style.copy(letterSpacing = 0.9.sp), color = onboardingTextSecondary)
      OutlinedTextField(
        value = manualHost,
        onValueChange = onManualHostChange,
        placeholder = { Text("10.0.2.2", color = onboardingTextTertiary, style = onboardingBodyStyle) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        textStyle = onboardingBodyStyle.copy(color = onboardingText),
        shape = RoundedCornerShape(14.dp),
        colors =
          OutlinedTextFieldDefaults.colors(
            focusedContainerColor = onboardingSurface,
            unfocusedContainerColor = onboardingSurface,
            focusedBorderColor = onboardingAccent,
            unfocusedBorderColor = onboardingBorder,
            focusedTextColor = onboardingText,
            unfocusedTextColor = onboardingText,
            cursorColor = onboardingAccent,
          ),
      )

      Text("PORT", style = onboardingCaption1Style.copy(letterSpacing = 0.9.sp), color = onboardingTextSecondary)
      OutlinedTextField(
        value = manualPort,
        onValueChange = onManualPortChange,
        placeholder = { Text("18789", color = onboardingTextTertiary, style = onboardingBodyStyle) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        textStyle = onboardingBodyStyle.copy(fontFamily = FontFamily.Monospace, color = onboardingText),
        shape = RoundedCornerShape(14.dp),
        colors =
          OutlinedTextFieldDefaults.colors(
            focusedContainerColor = onboardingSurface,
            unfocusedContainerColor = onboardingSurface,
            focusedBorderColor = onboardingAccent,
            unfocusedBorderColor = onboardingBorder,
            focusedTextColor = onboardingText,
            unfocusedTextColor = onboardingText,
            cursorColor = onboardingAccent,
          ),
      )

      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
      ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text("Use TLS", style = onboardingHeadlineStyle, color = onboardingText)
          Text("Switch to secure websocket (`wss`).", style = onboardingCalloutStyle.copy(lineHeight = 18.sp), color = onboardingTextSecondary)
        }
        Switch(
          checked = manualTls,
          onCheckedChange = onManualTlsChange,
          colors =
            SwitchDefaults.colors(
              checkedTrackColor = onboardingAccent,
              uncheckedTrackColor = onboardingBorderStrong,
              checkedThumbColor = Color.White,
              uncheckedThumbColor = Color.White,
            ),
        )
      }

      Text("TOKEN (OPTIONAL)", style = onboardingCaption1Style.copy(letterSpacing = 0.9.sp), color = onboardingTextSecondary)
      OutlinedTextField(
        value = gatewayToken,
        onValueChange = onTokenChange,
        placeholder = { Text("token", color = onboardingTextTertiary, style = onboardingBodyStyle) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
        textStyle = onboardingBodyStyle.copy(color = onboardingText),
        shape = RoundedCornerShape(14.dp),
        colors =
          OutlinedTextFieldDefaults.colors(
            focusedContainerColor = onboardingSurface,
            unfocusedContainerColor = onboardingSurface,
            focusedBorderColor = onboardingAccent,
            unfocusedBorderColor = onboardingBorder,
            focusedTextColor = onboardingText,
            unfocusedTextColor = onboardingText,
            cursorColor = onboardingAccent,
          ),
      )

      Text("PASSWORD (OPTIONAL)", style = onboardingCaption1Style.copy(letterSpacing = 0.9.sp), color = onboardingTextSecondary)
      OutlinedTextField(
        value = gatewayPassword,
        onValueChange = onPasswordChange,
        placeholder = { Text("password", color = onboardingTextTertiary, style = onboardingBodyStyle) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
        textStyle = onboardingBodyStyle.copy(color = onboardingText),
        shape = RoundedCornerShape(14.dp),
        colors =
          OutlinedTextFieldDefaults.colors(
            focusedContainerColor = onboardingSurface,
            unfocusedContainerColor = onboardingSurface,
            focusedBorderColor = onboardingAccent,
            unfocusedBorderColor = onboardingBorder,
            focusedTextColor = onboardingText,
            unfocusedTextColor = onboardingText,
            cursorColor = onboardingAccent,
          ),
      )

      if (!manualResolvedEndpoint.isNullOrBlank()) {
        ResolvedEndpoint(endpoint = manualResolvedEndpoint)
      }
    }

    if (!gatewayError.isNullOrBlank()) {
      Text(gatewayError, color = onboardingWarning, style = onboardingCaption1Style)
    }
  }
}

@Composable
private fun GuideBlock(
  title: String,
  content: @Composable ColumnScope.() -> Unit,
) {
  Row(modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
    Box(modifier = Modifier.width(2.dp).fillMaxHeight().background(onboardingAccent.copy(alpha = 0.4f)))
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(title, style = onboardingHeadlineStyle, color = onboardingText)
      content()
    }
  }
}

@Composable
private fun GatewayModeToggle(
  inputMode: GatewayInputMode,
  onInputModeChange: (GatewayInputMode) -> Unit,
) {
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
    GatewayModeChip(
      label = "Setup Code",
      active = inputMode == GatewayInputMode.SetupCode,
      onClick = { onInputModeChange(GatewayInputMode.SetupCode) },
      modifier = Modifier.weight(1f),
    )
    GatewayModeChip(
      label = "Manual",
      active = inputMode == GatewayInputMode.Manual,
      onClick = { onInputModeChange(GatewayInputMode.Manual) },
      modifier = Modifier.weight(1f),
    )
  }
}

@Composable
private fun GatewayModeChip(
  label: String,
  active: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Button(
    onClick = onClick,
    modifier = modifier.height(40.dp),
    shape = RoundedCornerShape(12.dp),
    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
    colors =
      ButtonDefaults.buttonColors(
        containerColor = if (active) onboardingAccent else onboardingSurface,
        contentColor = if (active) Color.White else onboardingText,
      ),
    border = androidx.compose.foundation.BorderStroke(1.dp, if (active) Color(0xFF184DAF) else onboardingBorderStrong),
  ) {
    Text(
      text = label,
      style = onboardingCaption1Style.copy(fontWeight = FontWeight.Bold),
    )
  }
}

@Composable
private fun QuickFillChip(
  label: String,
  onClick: () -> Unit,
) {
  TextButton(
    onClick = onClick,
    shape = RoundedCornerShape(999.dp),
    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 7.dp),
    colors =
      ButtonDefaults.textButtonColors(
        containerColor = onboardingAccentSoft,
        contentColor = onboardingAccent,
      ),
  ) {
    Text(label, style = onboardingCaption1Style.copy(fontWeight = FontWeight.SemiBold))
  }
}

@Composable
private fun ResolvedEndpoint(endpoint: String) {
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    HorizontalDivider(color = onboardingBorder)
    Text(
      "RESOLVED ENDPOINT",
      style = onboardingCaption2Style.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.7.sp),
      color = onboardingTextSecondary,
    )
    Text(
      endpoint,
      style = onboardingCalloutStyle.copy(fontFamily = FontFamily.Monospace),
      color = onboardingText,
    )
    HorizontalDivider(color = onboardingBorder)
  }
}

@Composable
private fun StepShell(
  title: String,
  content: @Composable ColumnScope.() -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
    HorizontalDivider(color = onboardingBorder)
    Column(modifier = Modifier.padding(vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text(title, style = onboardingTitle1Style, color = onboardingText)
      content()
    }
    HorizontalDivider(color = onboardingBorder)
  }
}

@Composable
private fun InlineDivider() {
  HorizontalDivider(color = onboardingBorder)
}

@Composable
private fun PermissionsStep(
  enableDiscovery: Boolean,
  enableNotifications: Boolean,
  enableMicrophone: Boolean,
  enableCamera: Boolean,
  enableSms: Boolean,
  smsAvailable: Boolean,
  context: Context,
  onDiscoveryChange: (Boolean) -> Unit,
  onNotificationsChange: (Boolean) -> Unit,
  onMicrophoneChange: (Boolean) -> Unit,
  onCameraChange: (Boolean) -> Unit,
  onSmsChange: (Boolean) -> Unit,
) {
  val discoveryPermission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.NEARBY_WIFI_DEVICES else Manifest.permission.ACCESS_FINE_LOCATION
  StepShell(title = "Permissions") {
    Text(
      "Enable only what you need now. You can change everything later in Settings.",
      style = onboardingCalloutStyle,
      color = onboardingTextSecondary,
    )
    PermissionToggleRow(
      title = "Gateway discovery",
      subtitle = if (Build.VERSION.SDK_INT >= 33) "Nearby devices" else "Location (for NSD)",
      checked = enableDiscovery,
      granted = isPermissionGranted(context, discoveryPermission),
      onCheckedChange = onDiscoveryChange,
    )
    InlineDivider()
    if (Build.VERSION.SDK_INT >= 33) {
      PermissionToggleRow(
        title = "Notifications",
        subtitle = "Foreground service + alerts",
        checked = enableNotifications,
        granted = isPermissionGranted(context, Manifest.permission.POST_NOTIFICATIONS),
        onCheckedChange = onNotificationsChange,
      )
      InlineDivider()
    }
    PermissionToggleRow(
      title = "Microphone",
      subtitle = "Talk mode + voice features",
      checked = enableMicrophone,
      granted = isPermissionGranted(context, Manifest.permission.RECORD_AUDIO),
      onCheckedChange = onMicrophoneChange,
    )
    InlineDivider()
    PermissionToggleRow(
      title = "Camera",
      subtitle = "camera.snap and camera.clip",
      checked = enableCamera,
      granted = isPermissionGranted(context, Manifest.permission.CAMERA),
      onCheckedChange = onCameraChange,
    )
    if (smsAvailable) {
      InlineDivider()
      PermissionToggleRow(
        title = "SMS",
        subtitle = "Allow gateway-triggered SMS sending",
        checked = enableSms,
        granted = isPermissionGranted(context, Manifest.permission.SEND_SMS),
        onCheckedChange = onSmsChange,
      )
    }
    Text("All settings can be changed later in Settings.", style = onboardingCalloutStyle, color = onboardingTextSecondary)
  }
}

@Composable
private fun PermissionToggleRow(
  title: String,
  subtitle: String,
  checked: Boolean,
  granted: Boolean,
  onCheckedChange: (Boolean) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(title, style = onboardingHeadlineStyle, color = onboardingText)
      Text(subtitle, style = onboardingCalloutStyle.copy(lineHeight = 18.sp), color = onboardingTextSecondary)
      Text(
        if (granted) "Granted" else "Not granted",
        style = onboardingCaption1Style,
        color = if (granted) onboardingSuccess else onboardingTextSecondary,
      )
    }
    Switch(
      checked = checked,
      onCheckedChange = onCheckedChange,
      colors =
        SwitchDefaults.colors(
          checkedTrackColor = onboardingAccent,
          uncheckedTrackColor = onboardingBorderStrong,
          checkedThumbColor = Color.White,
          uncheckedThumbColor = Color.White,
        ),
    )
  }
}

@Composable
private fun FinalStep(
  parsedGateway: ParsedGateway?,
  statusText: String,
  isConnected: Boolean,
  serverName: String?,
  remoteAddress: String?,
  attemptedConnect: Boolean,
  enabledPermissions: String,
  methodLabel: String,
) {
  StepShell(title = "Review") {
    SummaryField(label = "Method", value = methodLabel)
    SummaryField(label = "Gateway", value = parsedGateway?.displayUrl ?: "Invalid gateway URL")
    SummaryField(label = "Enabled Permissions", value = enabledPermissions)

    if (!attemptedConnect) {
      Text("Press Connect to verify gateway reachability and auth.", style = onboardingCalloutStyle, color = onboardingTextSecondary)
    } else {
      Text("Status: $statusText", style = onboardingCalloutStyle, color = if (isConnected) onboardingSuccess else onboardingTextSecondary)
      if (isConnected) {
        Text("Connected to ${serverName ?: remoteAddress ?: "gateway"}", style = onboardingCalloutStyle, color = onboardingSuccess)
      } else {
        GuideBlock(title = "Pairing Required") {
          Text("Run these on the gateway host:", style = onboardingCalloutStyle, color = onboardingTextSecondary)
          CommandBlock("openclaw nodes pending")
          CommandBlock("openclaw nodes approve <requestId>")
          Text("Then tap Connect again.", style = onboardingCalloutStyle, color = onboardingTextSecondary)
        }
      }
    }
  }
}

@Composable
private fun SummaryField(label: String, value: String) {
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(
      label,
      style = onboardingCaption2Style.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
      color = onboardingTextSecondary,
    )
    Text(value, style = onboardingHeadlineStyle, color = onboardingText)
    HorizontalDivider(color = onboardingBorder)
  }
}

@Composable
private fun CommandBlock(command: String) {
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .background(onboardingCommandBg, RoundedCornerShape(12.dp))
        .border(width = 1.dp, color = onboardingCommandBorder, shape = RoundedCornerShape(12.dp)),
  ) {
    Box(modifier = Modifier.width(3.dp).height(42.dp).background(onboardingCommandAccent))
    Text(
      command,
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
      style = onboardingCalloutStyle,
      fontFamily = FontFamily.Monospace,
      color = onboardingCommandText,
    )
  }
}

@Composable
private fun Bullet(text: String) {
  Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
    Box(
      modifier =
        Modifier
          .padding(top = 7.dp)
          .size(8.dp)
          .background(onboardingAccentSoft, CircleShape),
    )
    Box(
      modifier =
        Modifier
          .padding(top = 9.dp)
          .size(4.dp)
          .background(onboardingAccent, CircleShape),
    )
    Text(text, style = onboardingBodyStyle, color = onboardingTextSecondary, modifier = Modifier.weight(1f))
  }
}

private fun parseGateway(rawInput: String): ParsedGateway? {
  val raw = rawInput.trim()
  if (raw.isEmpty()) return null

  val normalized = if (raw.contains("://")) raw else "https://$raw"
  val uri = normalized.toUri()
  val host = uri.host?.trim().orEmpty()
  if (host.isEmpty()) return null

  val scheme = uri.scheme?.trim()?.lowercase(Locale.US).orEmpty()
  val tls =
    when (scheme) {
      "ws", "http" -> false
      "wss", "https" -> true
      else -> true
    }
  val port = uri.port.takeIf { it in 1..65535 } ?: 18789
  val displayUrl = "${if (tls) "https" else "http"}://$host:$port"

  return ParsedGateway(host = host, port = port, tls = tls, displayUrl = displayUrl)
}

private fun decodeSetupCode(rawInput: String): SetupCodePayload? {
  val trimmed = rawInput.trim()
  if (trimmed.isEmpty()) return null

  val padded =
    trimmed
      .replace('-', '+')
      .replace('_', '/')
      .let { normalized ->
        val remainder = normalized.length % 4
        if (remainder == 0) normalized else normalized + "=".repeat(4 - remainder)
      }

  return try {
    val decoded = String(Base64.decode(padded, Base64.DEFAULT), Charsets.UTF_8)
    val obj = JSONObject(decoded)
    val url = obj.optString("url").trim()
    if (url.isEmpty()) return null
    val token = obj.optString("token").trim().ifEmpty { null }
    val password = obj.optString("password").trim().ifEmpty { null }
    SetupCodePayload(url = url, token = token, password = password)
  } catch (_: Throwable) {
    null
  }
}

private fun isPermissionGranted(context: Context, permission: String): Boolean {
  return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}

private fun composeManualGatewayUrl(hostInput: String, portInput: String, tls: Boolean): String? {
  val host = hostInput.trim()
  val port = portInput.trim().toIntOrNull() ?: return null
  if (host.isEmpty() || port !in 1..65535) return null
  val scheme = if (tls) "https" else "http"
  return "$scheme://$host:$port"
}
