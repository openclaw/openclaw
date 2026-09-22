package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.MainViewModel.GatewayAdditionRequest
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.formatGatewayAuthority
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.atomic.AtomicBoolean

private sealed interface GatewayAdditionStep {
  data object Scan : GatewayAdditionStep

  data class ScanError(
    val message: String,
  ) : GatewayAdditionStep

  data class Code(
    val error: String? = null,
  ) : GatewayAdditionStep

  data class Manual(
    val error: String? = null,
  ) : GatewayAdditionStep

  class ReadingImage : GatewayAdditionStep

  class Review(
    val config: GatewayConnectConfig,
    val previous: GatewayAdditionStep,
  ) : GatewayAdditionStep
}

/** Heap-only input lives above the existing shell; nothing is applied until Connect is admitted. */
@Composable
internal fun GatewayAdditionDialog(
  viewModel: MainViewModel,
  request: GatewayAdditionRequest,
) {
  val context = LocalContext.current
  val active = remember(request) { AtomicBoolean(true) }
  var step by remember(request) { mutableStateOf<GatewayAdditionStep>(GatewayAdditionStep.Scan) }
  var setupCode by remember(request) { mutableStateOf("") }
  var address by remember(request) { mutableStateOf("") }
  var token by remember(request) { mutableStateOf("") }
  var password by remember(request) { mutableStateOf("") }
  var cameraAllowed by remember {
    mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
  }
  val scanner =
    remember(request) {
      BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
    }
  val handoff by viewModel.gatewayConnectionHandoff.collectAsState()
  val gateways by viewModel.pairedGateways.collectAsState()

  fun isCurrent() = active.get() && viewModel.gatewayAdditionRequest.value === request

  fun cancel() = viewModel.dismissGatewayAddition(request)

  fun back() {
    step =
      when (val current = step) {
        is GatewayAdditionStep.Review -> {
          current.previous
        }

        GatewayAdditionStep.Scan, is GatewayAdditionStep.ScanError -> {
          cancel()
          return
        }

        else -> {
          GatewayAdditionStep.Scan
        }
      }
  }
  DisposableEffect(request, scanner) {
    onDispose {
      active.set(false)
      scanner.close()
      setupCode = ""
      token = ""
      password = ""
      step = GatewayAdditionStep.Scan
    }
  }
  val permission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      if (isCurrent()) cameraAllowed = granted
    }

  fun stageCode(
    raw: String,
    previous: GatewayAdditionStep,
  ) {
    if (!isCurrent()) return
    val decoded = resolveScannedSetupCodeResult(raw)
    val config =
      decoded.setupCode?.let { code ->
        resolveGatewayConnectConfig(true, code, "", "", false, "", "", "")
      }
    step =
      if (config != null) {
        GatewayAdditionStep.Review(config, previous)
      } else {
        val message = gatewayEndpointValidationMessage(decoded.error ?: GatewayEndpointValidationError.INVALID_URL, GatewayEndpointInputSource.QR_SCAN)
        if (previous is GatewayAdditionStep.Code) GatewayAdditionStep.Code(message) else GatewayAdditionStep.ScanError(message)
      }
  }
  val gallery =
    rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
      val reading = step as? GatewayAdditionStep.ReadingImage ?: return@rememberLauncherForActivityResult
      if (!isCurrent()) return@rememberLauncherForActivityResult
      if (uri == null) {
        step = GatewayAdditionStep.Scan
        return@rememberLauncherForActivityResult
      }
      val image =
        try {
          InputImage.fromFilePath(context, uri)
        } catch (_: Exception) {
          step = GatewayAdditionStep.ScanError(nativeString("Could not read the selected image."))
          return@rememberLauncherForActivityResult
        }
      scanner
        .process(image)
        .addOnSuccessListener { barcodes ->
          if (!isCurrent() || step !== reading) return@addOnSuccessListener
          val raw = barcodes.firstNotNullOfOrNull { it.rawValue?.takeIf(String::isNotBlank) }
          if (raw == null) {
            step = GatewayAdditionStep.ScanError(nativeString("No QR code found in the selected image."))
          } else {
            stageCode(raw, GatewayAdditionStep.Scan)
          }
        }.addOnFailureListener {
          if (isCurrent() && step === reading) step = GatewayAdditionStep.ScanError(nativeString("Could not read the QR code from this image."))
        }
    }

  fun stageManual() {
    if (!isCurrent()) return
    if (manualTokenLooksLikeSetupCode(token)) {
      step = GatewayAdditionStep.Manual(nativeString("Use Enter setup code to paste a setup code."))
      return
    }
    val config = resolveGatewayConnectConfig(false, "", address, "", true, "", token, password)
    step =
      if (config != null) {
        GatewayAdditionStep.Review(config, GatewayAdditionStep.Manual())
      } else {
        val error = composeGatewayManualUrl(address, "", true)?.let(::parseGatewayEndpointResult)?.error ?: GatewayEndpointValidationError.INVALID_URL
        GatewayAdditionStep.Manual(gatewayEndpointValidationMessage(error, GatewayEndpointInputSource.MANUAL))
      }
  }
  FoldAwareDialog(onDismissRequest = ::back, title = nativeString("Add Gateway")) {
    Surface(
      modifier = Modifier.fillMaxWidth().testTag("gateway-addition"),
      shape = RoundedCornerShape(ClawTheme.radii.sheet),
      color = ClawTheme.colors.surface,
      contentColor = ClawTheme.colors.text,
    ) {
      Column(
        modifier = Modifier.heightIn(max = 680.dp).verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          IconButton(onClick = ::back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, nativeString("Back")) }
          Text(nativeString("Add Gateway"), style = ClawTheme.type.title)
        }
        when (val current = step) {
          GatewayAdditionStep.Scan, is GatewayAdditionStep.ScanError -> {
            (current as? GatewayAdditionStep.ScanError)?.let { Text(it.message, color = ClawTheme.colors.warning) }
            SetupQrScanner(
              scannerActive = current == GatewayAdditionStep.Scan,
              cameraPermissionGranted = cameraAllowed,
              scanner = scanner,
              onClick = { step = GatewayAdditionStep.Scan },
              onClose = ::cancel,
              onRequestCameraPermission = { permission.launch(Manifest.permission.CAMERA) },
              onCodeScanned = { raw -> if (step == GatewayAdditionStep.Scan) stageCode(raw, GatewayAdditionStep.Scan) },
              onCameraError = { if (isCurrent() && step == GatewayAdditionStep.Scan) step = GatewayAdditionStep.ScanError(nativeString("Could not start the camera.")) },
            )
            ClawSecondaryButton(text = nativeString("Enter setup code"), onClick = { step = GatewayAdditionStep.Code() }, modifier = Modifier.fillMaxWidth())
            ClawSecondaryButton(text = nativeString("Choose from gallery"), onClick = {
              step = GatewayAdditionStep.ReadingImage()
              gallery.launch("image/*")
            }, modifier = Modifier.fillMaxWidth())
            TextButton(onClick = { step = GatewayAdditionStep.Manual() }) { Text(nativeString("Set up manually")) }
          }

          is GatewayAdditionStep.ReadingImage -> {
            CircularProgressIndicator()
            Text(nativeString("Reading QR code…"))
          }

          is GatewayAdditionStep.Code -> {
            ClawTextField(value = setupCode, onValueChange = { setupCode = it }, placeholder = nativeString("Setup code"), secret = true, modifier = Modifier.testTag("gateway-add-code"))
            current.error?.let { Text(it, color = ClawTheme.colors.warning) }
            ClawPrimaryButton(text = nativeString("Continue"), onClick = { stageCode(setupCode, GatewayAdditionStep.Code()) }, modifier = Modifier.fillMaxWidth())
          }

          is GatewayAdditionStep.Manual -> {
            ClawTextField(value = address, onValueChange = { address = it }, placeholder = nativeString("Gateway URL"), modifier = Modifier.testTag("gateway-add-address"))
            ClawTextField(value = token, onValueChange = { token = it }, placeholder = nativeString("Token (optional)"), secret = true)
            ClawTextField(value = password, onValueChange = { password = it }, placeholder = nativeString("Password (optional)"), secret = true)
            current.error?.let { Text(it, color = ClawTheme.colors.warning) }
            ClawPrimaryButton(text = nativeString("Continue"), onClick = ::stageManual, modifier = Modifier.fillMaxWidth())
          }

          is GatewayAdditionStep.Review -> {
            val config = current.config
            val endpoint = GatewayEndpoint.manual(config.host, config.port, config.tls, config.contextPath)
            Text(nativeString("Connect to this gateway?"), style = ClawTheme.type.section)
            Text((if (config.tls) "wss://" else "ws://") + formatGatewayAuthority(config.host, config.port) + config.contextPath, modifier = Modifier.testTag("gateway-add-preview"))
            Text(nativeString("Your current connection stays unchanged until you choose Connect."), style = ClawTheme.type.body)
            if (gateways.any { it.stableId == endpoint.stableId }) {
              Text(nativeString("Already saved. Your saved connection settings will be used."), style = ClawTheme.type.caption)
            }
            ClawPrimaryButton(
              text = nativeString("Connect"),
              enabled = !handoff.pending,
              onClick = { if (isCurrent()) viewModel.saveGatewayConfigAndConnect(GatewayConnectPlan(config, GatewaySavedAuthAction.REPLACE_SETUP), request) },
              modifier = Modifier.fillMaxWidth().testTag("gateway-add-connect"),
            )
          }
        }
        TextButton(onClick = ::cancel, modifier = Modifier.fillMaxWidth()) { Text(nativeString("Cancel")) }
      }
    }
  }
}
