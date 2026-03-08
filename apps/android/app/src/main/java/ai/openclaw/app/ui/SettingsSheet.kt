package ai.openclaw.app.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import ai.openclaw.app.BuildConfig
import ai.openclaw.app.LocationMode
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NotificationPackageFilterMode
import ai.openclaw.app.node.DeviceNotificationListenerService

@Composable
fun SettingsSheet(viewModel: MainViewModel) {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val instanceId by viewModel.instanceId.collectAsState()
  val displayName by viewModel.displayName.collectAsState()
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val locationMode by viewModel.locationMode.collectAsState()
  val locationPreciseEnabled by viewModel.locationPreciseEnabled.collectAsState()
  val preventSleep by viewModel.preventSleep.collectAsState()
  val canvasDebugStatusEnabled by viewModel.canvasDebugStatusEnabled.collectAsState()
  val notificationForwardingEnabled by viewModel.notificationForwardingEnabled.collectAsState()
  val notificationForwardingMode by viewModel.notificationForwardingMode.collectAsState()
  val notificationForwardingPackages by viewModel.notificationForwardingPackages.collectAsState()
  val notificationForwardingQuietHoursEnabled by viewModel.notificationForwardingQuietHoursEnabled.collectAsState()
  val notificationForwardingQuietStart by viewModel.notificationForwardingQuietStart.collectAsState()
  val notificationForwardingQuietEnd by viewModel.notificationForwardingQuietEnd.collectAsState()
  val notificationForwardingMaxEventsPerMinute by viewModel.notificationForwardingMaxEventsPerMinute.collectAsState()
  val notificationForwardingSessionKey by viewModel.notificationForwardingSessionKey.collectAsState()

  var notificationPackagesDraft by remember(notificationForwardingPackages) {
    mutableStateOf(notificationForwardingPackages.sorted().joinToString(", "))
  }
  var notificationQuietStartDraft by remember(notificationForwardingQuietStart) {
    mutableStateOf(notificationForwardingQuietStart)
  }
  var notificationQuietEndDraft by remember(notificationForwardingQuietEnd) {
    mutableStateOf(notificationForwardingQuietEnd)
  }
  var notificationRateDraft by remember(notificationForwardingMaxEventsPerMinute) {
    mutableStateOf(notificationForwardingMaxEventsPerMinute.toString())
  }
  var notificationSessionKeyDraft by remember(notificationForwardingSessionKey) {
    mutableStateOf(notificationForwardingSessionKey.orEmpty())
  }

  val listState = rememberLazyListState()
  val deviceModel =
    remember {
      listOfNotNull(Build.MANUFACTURER, Build.MODEL)
        .joinToString(" ")
        .trim()
        .ifEmpty { "Android" }
    }
  val appVersion =
    remember {
      val versionName = BuildConfig.VERSION_NAME.trim().ifEmpty { "dev" }
      if (BuildConfig.DEBUG && !versionName.contains("dev", ignoreCase = true)) {
        "$versionName-dev"
      } else {
        versionName
      }
    }
  val listItemColors =
    ListItemDefaults.colors(
      containerColor = Color.Transparent,
      headlineColor = mobileText,
      supportingColor = mobileTextSecondary,
      trailingIconColor = mobileTextSecondary,
      leadingIconColor = mobileTextSecondary,
    )

  val permissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
      val cameraOk = perms[Manifest.permission.CAMERA] == true
      viewModel.setCameraEnabled(cameraOk)
    }

  var pendingLocationRequest by remember { mutableStateOf(false) }
  var pendingPreciseToggle by remember { mutableStateOf(false) }

  val locationPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
      val fineOk = perms[Manifest.permission.ACCESS_FINE_LOCATION] == true
      val coarseOk = perms[Manifest.permission.ACCESS_COARSE_LOCATION] == true
      val granted = fineOk || coarseOk

      if (pendingPreciseToggle) {
        pendingPreciseToggle = false
        viewModel.setLocationPreciseEnabled(fineOk)
        return@rememberLauncherForActivityResult
      }

      if (pendingLocationRequest) {
        pendingLocationRequest = false
        viewModel.setLocationMode(if (granted) LocationMode.WhileUsing else LocationMode.Off)
      }
    }

  var micPermissionGranted by
    remember {
      mutableStateOf(
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
          PackageManager.PERMISSION_GRANTED,
      )
    }
  val audioPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      micPermissionGranted = granted
    }

  val smsPermissionAvailable =
    remember {
      BuildConfig.OPENCLAW_ENABLE_SMS &&
        context.packageManager?.hasSystemFeature(PackageManager.FEATURE_TELEPHONY) == true
    }
  val callLogPermissionAvailable = remember { BuildConfig.OPENCLAW_ENABLE_CALL_LOG }
  val photosPermission =
    if (Build.VERSION.SDK_INT >= 33) {
      Manifest.permission.READ_MEDIA_IMAGES
    } else {
      Manifest.permission.READ_EXTERNAL_STORAGE
    }
  val motionPermissionRequired = true
  val motionAvailable = remember(context) { hasMotionCapabilities(context) }

  var notificationsPermissionGranted by
    remember {
      mutableStateOf(hasNotificationsPermission(context))
    }
  val notificationsPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      notificationsPermissionGranted = granted
    }

  var notificationListenerEnabled by
    remember {
      mutableStateOf(isNotificationListenerEnabled(context))
    }

  var photosPermissionGranted by
    remember {
      mutableStateOf(
        ContextCompat.checkSelfPermission(context, photosPermission) ==
          PackageManager.PERMISSION_GRANTED,
      )
    }
  val photosPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      photosPermissionGranted = granted
    }

  var contactsPermissionGranted by
    remember {
      mutableStateOf(
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) ==
          PackageManager.PERMISSION_GRANTED &&
          ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CONTACTS) ==
          PackageManager.PERMISSION_GRANTED,
      )
    }
  val contactsPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
      val readOk = perms[Manifest.permission.READ_CONTACTS] == true
      val writeOk = perms[Manifest.permission.WRITE_CONTACTS] == true
      contactsPermissionGranted = readOk && writeOk
    }

  var calendarPermissionGranted by
    remember {
      mutableStateOf(
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) ==
          PackageManager.PERMISSION_GRANTED &&
          ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) ==
          PackageManager.PERMISSION_GRANTED,
      )
    }
  val calendarPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
      val readOk = perms[Manifest.permission.READ_CALENDAR] == true
      val writeOk = perms[Manifest.permission.WRITE_CALENDAR] == true
      calendarPermissionGranted = readOk && writeOk
    }

  var callLogPermissionGranted by
    remember {
      mutableStateOf(
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALL_LOG) ==
          PackageManager.PERMISSION_GRANTED,
      )
    }
  val callLogPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      callLogPermissionGranted = granted
    }

  var motionPermissionGranted by
    remember {
      mutableStateOf(
        !motionPermissionRequired ||
          ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) ==
          PackageManager.PERMISSION_GRANTED,
      )
    }
  val motionPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      motionPermissionGranted = granted
    }

  var smsPermissionGranted by
    remember {
      mutableStateOf(
        ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) ==
          PackageManager.PERMISSION_GRANTED &&
          ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) ==
          PackageManager.PERMISSION_GRANTED,
      )
    }
  val smsPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
      val sendOk = perms[Manifest.permission.SEND_SMS] == true
      val readOk = perms[Manifest.permission.READ_SMS] == true
      smsPermissionGranted = sendOk && readOk
      viewModel.refreshGatewayConnection()
    }

  DisposableEffect(lifecycleOwner, context) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) {
          micPermissionGranted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
              PackageManager.PERMISSION_GRANTED
          notificationsPermissionGranted = hasNotificationsPermission(context)
          notificationListenerEnabled = isNotificationListenerEnabled(context)
          photosPermissionGranted =
            ContextCompat.checkSelfPermission(context, photosPermission) ==
              PackageManager.PERMISSION_GRANTED
          contactsPermissionGranted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) ==
              PackageManager.PERMISSION_GRANTED &&
              ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CONTACTS) ==
              PackageManager.PERMISSION_GRANTED
          calendarPermissionGranted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) ==
              PackageManager.PERMISSION_GRANTED &&
              ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) ==
              PackageManager.PERMISSION_GRANTED
          callLogPermissionGranted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALL_LOG) ==
              PackageManager.PERMISSION_GRANTED
          motionPermissionGranted =
            !motionPermissionRequired ||
              ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) ==
              PackageManager.PERMISSION_GRANTED
          smsPermissionGranted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) ==
              PackageManager.PERMISSION_GRANTED &&
              ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) ==
              PackageManager.PERMISSION_GRANTED
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }

  fun setCameraEnabledChecked(checked: Boolean) {
    if (!checked) {
      viewModel.setCameraEnabled(false)
      return
    }

    val cameraOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED
    if (cameraOk) {
      viewModel.setCameraEnabled(true)
    } else {
      permissionLauncher.launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO))
    }
  }

  fun requestLocationPermissions() {
    val fineOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val coarseOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (fineOk || coarseOk) {
      viewModel.setLocationMode(LocationMode.WhileUsing)
    } else {
      pendingLocationRequest = true
      locationPermissionLauncher.launch(
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
      )
    }
  }

  fun setPreciseLocationChecked(checked: Boolean) {
    if (!checked) {
      viewModel.setLocationPreciseEnabled(false)
      return
    }
    val fineOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (fineOk) {
      viewModel.setLocationPreciseEnabled(true)
    } else {
      pendingPreciseToggle = true
      locationPermissionLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION))
    }
  }

  Box(
    modifier =
      Modifier
        .fillMaxSize()
        .background(mobileBackgroundGradient),
  ) {
    LazyColumn(
      state = listState,
      modifier =
        Modifier
          .fillMaxWidth()
          .fillMaxHeight()
          .imePadding()
          .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)),
      contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      // ── Node ──
      item {
        Text(
          "DEVICE",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
      item {
        Column(modifier = Modifier.settingsRowModifier()) {
          OutlinedTextField(
            value = displayName,
            onValueChange = viewModel::setDisplayName,
            label = { Text("Name", style = mobileCaption1, color = mobileTextSecondary) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
            textStyle = mobileBody.copy(color = mobileText),
            colors = settingsTextFieldColors(),
          )
          HorizontalDivider(color = mobileBorder)
          Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
          ) {
            Text("$deviceModel · $appVersion", style = mobileCallout, color = mobileTextSecondary)
            Text(
              instanceId.take(8) + "…",
              style = mobileCaption1.copy(fontFamily = FontFamily.Monospace),
              color = mobileTextTertiary,
            )
          }
        }
      }

      // ── Media ──
      item {
        Text(
          "MEDIA",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
      item {
        Column(modifier = Modifier.settingsRowModifier()) {
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Microphone", style = mobileHeadline) },
            supportingContent = {
              Text(
                if (micPermissionGranted) "Granted" else "Required for voice transcription.",
                style = mobileCallout,
              )
            },
            trailingContent = {
              Button(
                onClick = {
                  if (micPermissionGranted) {
                    openAppSettings(context)
                  } else {
                    audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                  }
                },
                colors = settingsPrimaryButtonColors(),
                shape = RoundedCornerShape(14.dp),
              ) {
                Text(
                  if (micPermissionGranted) "Manage" else "Grant",
                  style = mobileCallout.copy(fontWeight = FontWeight.Bold),
                )
              }
            },
          )
          HorizontalDivider(color = mobileBorder)
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Camera", style = mobileHeadline) },
            supportingContent = { Text("Photos and video clips (foreground only).", style = mobileCallout) },
            trailingContent = { Switch(checked = cameraEnabled, onCheckedChange = ::setCameraEnabledChecked) },
          )
        }
      }

      // ── Notifications & Messaging ──
      item {
        Text(
          "NOTIFICATIONS",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
      item {
        Column(modifier = Modifier.settingsRowModifier()) {
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("System Notifications", style = mobileHeadline) },
            supportingContent = {
              Text("Alerts and foreground service.", style = mobileCallout)
            },
            trailingContent = {
              Button(
                onClick = {
                  if (notificationsPermissionGranted || Build.VERSION.SDK_INT < 33) {
                    openAppSettings(context)
                  } else {
                    notificationsPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                  }
                },
                colors = settingsPrimaryButtonColors(),
                shape = RoundedCornerShape(14.dp),
              ) {
                Text(
                  if (notificationsPermissionGranted) "Manage" else "Grant",
                  style = mobileCallout.copy(fontWeight = FontWeight.Bold),
                )
              }
            },
          )
          HorizontalDivider(color = mobileBorder)
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Notification Listener", style = mobileHeadline) },
            supportingContent = {
              Text("Read and interact with notifications.", style = mobileCallout)
            },
            trailingContent = {
              Button(
                onClick = { openNotificationListenerSettings(context) },
                colors = settingsPrimaryButtonColors(),
                shape = RoundedCornerShape(14.dp),
              ) {
                Text(
                  if (notificationListenerEnabled) "Manage" else "Enable",
                  style = mobileCallout.copy(fontWeight = FontWeight.Bold),
                )
              }
            },
          )
          if (smsPermissionAvailable) {
            HorizontalDivider(color = mobileBorder)
            ListItem(
              modifier = Modifier.fillMaxWidth(),
              colors = listItemColors,
              headlineContent = { Text("SMS", style = mobileHeadline) },
              supportingContent = {
                Text("Send and search SMS from this device.", style = mobileCallout)
              },
              trailingContent = {
                Button(
                  onClick = {
                    if (smsPermissionGranted) {
                      openAppSettings(context)
                    } else {
                      smsPermissionLauncher.launch(arrayOf(Manifest.permission.SEND_SMS, Manifest.permission.READ_SMS))
                    }
                  },
                  colors = settingsPrimaryButtonColors(),
                  shape = RoundedCornerShape(14.dp),
                ) {
                  Text(
                    if (smsPermissionGranted) "Manage" else "Grant",
                    style = mobileCallout.copy(fontWeight = FontWeight.Bold),
                  )
                }
              },
            )
          }
        }
      }
      item {
        Column(modifier = Modifier.settingsRowModifier(), verticalArrangement = Arrangement.spacedBy(0.dp)) {
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Forward notification events", style = mobileHeadline) },
            supportingContent = {
              Text(
                "Forward posted/removed notification events to the gateway using a local policy.",
                style = mobileCallout,
              )
            },
            trailingContent = {
              Switch(
                checked = notificationForwardingEnabled,
                onCheckedChange = viewModel::setNotificationForwardingEnabled,
                enabled = notificationListenerEnabled,
              )
            },
          )
          HorizontalDivider(color = mobileBorder)
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Filter mode", style = mobileHeadline) },
            supportingContent = {
              Text(
                if (notificationForwardingMode == NotificationPackageFilterMode.Allowlist) {
                  "Only packages listed below are forwarded."
                } else {
                  "Packages listed below are blocked from forwarding. OpenClaw is always blocked by default."
                },
                style = mobileCallout,
              )
            },
          )
          Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
          ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
              RadioButton(
                selected = notificationForwardingMode == NotificationPackageFilterMode.Blocklist,
                onClick = { viewModel.setNotificationForwardingMode(NotificationPackageFilterMode.Blocklist) },
                enabled = notificationForwardingEnabled,
              )
              Text("Blocklist", style = mobileCallout, color = mobileText)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
              RadioButton(
                selected = notificationForwardingMode == NotificationPackageFilterMode.Allowlist,
                onClick = { viewModel.setNotificationForwardingMode(NotificationPackageFilterMode.Allowlist) },
                enabled = notificationForwardingEnabled,
              )
              Text("Allowlist", style = mobileCallout, color = mobileText)
            }
          }
          HorizontalDivider(color = mobileBorder)
          Column(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(
              value = notificationPackagesDraft,
              onValueChange = { notificationPackagesDraft = it },
              label = { Text("Packages (comma separated)", style = mobileCaption1, color = mobileTextSecondary) },
              modifier = Modifier.fillMaxWidth(),
              enabled = notificationForwardingEnabled,
              textStyle = mobileBody.copy(color = mobileText),
              colors = settingsTextFieldColors(),
            )
            Button(
              onClick = { viewModel.setNotificationForwardingPackagesCsv(notificationPackagesDraft) },
              enabled = notificationForwardingEnabled,
              colors = settingsPrimaryButtonColors(),
              shape = RoundedCornerShape(14.dp),
            ) {
              Text("Save package filters", style = mobileCallout.copy(fontWeight = FontWeight.Bold))
            }
          }
          HorizontalDivider(color = mobileBorder)
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Quiet hours", style = mobileHeadline) },
            supportingContent = {
              Text(
                "Suppress forwarding during a local time window.",
                style = mobileCallout,
              )
            },
            trailingContent = {
              Switch(
                checked = notificationForwardingQuietHoursEnabled,
                onCheckedChange = {
                  viewModel.setNotificationForwardingQuietHours(
                    enabled = it,
                    start = notificationQuietStartDraft,
                    end = notificationQuietEndDraft,
                  )
                },
                enabled = notificationForwardingEnabled,
              )
            },
          )
          Column(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(
              value = notificationQuietStartDraft,
              onValueChange = { notificationQuietStartDraft = it },
              label = { Text("Quiet start (HH:MM)", style = mobileCaption1, color = mobileTextSecondary) },
              modifier = Modifier.fillMaxWidth(),
              enabled = notificationForwardingEnabled,
              textStyle = mobileBody.copy(color = mobileText),
              colors = settingsTextFieldColors(),
            )
            OutlinedTextField(
              value = notificationQuietEndDraft,
              onValueChange = { notificationQuietEndDraft = it },
              label = { Text("Quiet end (HH:MM)", style = mobileCaption1, color = mobileTextSecondary) },
              modifier = Modifier.fillMaxWidth(),
              enabled = notificationForwardingEnabled,
              textStyle = mobileBody.copy(color = mobileText),
              colors = settingsTextFieldColors(),
            )
            Button(
              onClick = {
                viewModel.setNotificationForwardingQuietHours(
                  enabled = notificationForwardingQuietHoursEnabled,
                  start = notificationQuietStartDraft,
                  end = notificationQuietEndDraft,
                )
              },
              enabled = notificationForwardingEnabled,
              colors = settingsPrimaryButtonColors(),
              shape = RoundedCornerShape(14.dp),
            ) {
              Text("Save quiet hours", style = mobileCallout.copy(fontWeight = FontWeight.Bold))
            }
          }
          HorizontalDivider(color = mobileBorder)
          Column(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(
              value = notificationRateDraft,
              onValueChange = { notificationRateDraft = it.filter { ch -> ch.isDigit() } },
              label = { Text("Max events per minute", style = mobileCaption1, color = mobileTextSecondary) },
              modifier = Modifier.fillMaxWidth(),
              enabled = notificationForwardingEnabled,
              textStyle = mobileBody.copy(color = mobileText),
              colors = settingsTextFieldColors(),
            )
            Button(
              onClick = {
                viewModel.setNotificationForwardingMaxEventsPerMinute(
                  notificationRateDraft.toIntOrNull() ?: notificationForwardingMaxEventsPerMinute,
                )
              },
              enabled = notificationForwardingEnabled,
              colors = settingsPrimaryButtonColors(),
              shape = RoundedCornerShape(14.dp),
            ) {
              Text("Save rate limit", style = mobileCallout.copy(fontWeight = FontWeight.Bold))
            }
            Text(
              "Current: $notificationForwardingMaxEventsPerMinute events/minute",
              style = mobileCallout,
              color = mobileTextSecondary,
            )
          }
          HorizontalDivider(color = mobileBorder)
          Column(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(
              value = notificationSessionKeyDraft,
              onValueChange = { notificationSessionKeyDraft = it },
              label = { Text("Session key override (optional)", style = mobileCaption1, color = mobileTextSecondary) },
              modifier = Modifier.fillMaxWidth(),
              enabled = notificationForwardingEnabled,
              textStyle = mobileBody.copy(color = mobileText),
              colors = settingsTextFieldColors(),
            )
            Button(
              onClick = { viewModel.setNotificationForwardingSessionKey(notificationSessionKeyDraft.ifBlank { null }) },
              enabled = notificationForwardingEnabled,
              colors = settingsPrimaryButtonColors(),
              shape = RoundedCornerShape(14.dp),
            ) {
              Text("Save session route", style = mobileCallout.copy(fontWeight = FontWeight.Bold))
            }
          }
        }
      }
      item { HorizontalDivider(color = mobileBorder) }

      // ── Data Access ──
      item {
        Text(
          "DATA ACCESS",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
      item {
        Column(modifier = Modifier.settingsRowModifier()) {
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Photos", style = mobileHeadline) },
            supportingContent = { Text("Access recent photos.", style = mobileCallout) },
            trailingContent = {
              Button(
                onClick = {
                  if (photosPermissionGranted) {
                    openAppSettings(context)
                  } else {
                    photosPermissionLauncher.launch(photosPermission)
                  }
                },
                colors = settingsPrimaryButtonColors(),
                shape = RoundedCornerShape(14.dp),
              ) {
                Text(
                  if (photosPermissionGranted) "Manage" else "Grant",
                  style = mobileCallout.copy(fontWeight = FontWeight.Bold),
                )
              }
            },
          )
          HorizontalDivider(color = mobileBorder)
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Contacts", style = mobileHeadline) },
            supportingContent = { Text("Search and add contacts.", style = mobileCallout) },
            trailingContent = {
              Button(
                onClick = {
                  if (contactsPermissionGranted) {
                    openAppSettings(context)
                  } else {
                    contactsPermissionLauncher.launch(arrayOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS))
                  }
                },
                colors = settingsPrimaryButtonColors(),
                shape = RoundedCornerShape(14.dp),
              ) {
                Text(
                  if (contactsPermissionGranted) "Manage" else "Grant",
                  style = mobileCallout.copy(fontWeight = FontWeight.Bold),
                )
              }
            },
          )
          HorizontalDivider(color = mobileBorder)
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Calendar", style = mobileHeadline) },
            supportingContent = { Text("Read and create events.", style = mobileCallout) },
            trailingContent = {
              Button(
                onClick = {
                  if (calendarPermissionGranted) {
                    openAppSettings(context)
                  } else {
                    calendarPermissionLauncher.launch(arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR))
                  }
                },
                colors = settingsPrimaryButtonColors(),
                shape = RoundedCornerShape(14.dp),
              ) {
                Text(
                  if (calendarPermissionGranted) "Manage" else "Grant",
                  style = mobileCallout.copy(fontWeight = FontWeight.Bold),
                )
              }
            },
          )
          if (callLogPermissionAvailable) {
            HorizontalDivider(color = mobileBorder)
            ListItem(
              modifier = Modifier.fillMaxWidth(),
              colors = listItemColors,
              headlineContent = { Text("Call Log", style = mobileHeadline) },
              supportingContent = { Text("Search recent call history.", style = mobileCallout) },
              trailingContent = {
                Button(
                  onClick = {
                    if (callLogPermissionGranted) {
                      openAppSettings(context)
                    } else {
                      callLogPermissionLauncher.launch(Manifest.permission.READ_CALL_LOG)
                    }
                  },
                  colors = settingsPrimaryButtonColors(),
                  shape = RoundedCornerShape(14.dp),
                ) {
                  Text(
                    if (callLogPermissionGranted) "Manage" else "Grant",
                    style = mobileCallout.copy(fontWeight = FontWeight.Bold),
                  )
                }
              },
            )
          }
          if (motionAvailable) {
            HorizontalDivider(color = mobileBorder)
            ListItem(
              modifier = Modifier.fillMaxWidth(),
              colors = listItemColors,
              headlineContent = { Text("Motion", style = mobileHeadline) },
              supportingContent = { Text("Track steps and activity.", style = mobileCallout) },
              trailingContent = {
                val motionButtonLabel =
                  when {
                    !motionPermissionRequired -> "Manage"
                    motionPermissionGranted -> "Manage"
                    else -> "Grant"
                  }
                Button(
                  onClick = {
                    if (!motionPermissionRequired || motionPermissionGranted) {
                      openAppSettings(context)
                    } else {
                      motionPermissionLauncher.launch(Manifest.permission.ACTIVITY_RECOGNITION)
                    }
                  },
                  colors = settingsPrimaryButtonColors(),
                  shape = RoundedCornerShape(14.dp),
                ) {
                  Text(motionButtonLabel, style = mobileCallout.copy(fontWeight = FontWeight.Bold))
                }
              },
            )
          }
        }
      }

      // ── Location ──
      item {
        Text(
          "LOCATION",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
      item {
        Column(modifier = Modifier.settingsRowModifier()) {
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Off", style = mobileHeadline) },
            supportingContent = { Text("Disable location sharing.", style = mobileCallout) },
            trailingContent = {
              RadioButton(
                selected = locationMode == LocationMode.Off,
                onClick = { viewModel.setLocationMode(LocationMode.Off) },
              )
            },
          )
          HorizontalDivider(color = mobileBorder)
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("While Using", style = mobileHeadline) },
            supportingContent = { Text("Only while OpenClaw is open.", style = mobileCallout) },
            trailingContent = {
              RadioButton(
                selected = locationMode == LocationMode.WhileUsing,
                onClick = { requestLocationPermissions() },
              )
            },
          )
          HorizontalDivider(color = mobileBorder)
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Precise Location", style = mobileHeadline) },
            supportingContent = { Text("Use precise GPS when available.", style = mobileCallout) },
            trailingContent = {
              Switch(
                checked = locationPreciseEnabled,
                onCheckedChange = ::setPreciseLocationChecked,
                enabled = locationMode != LocationMode.Off,
              )
            },
          )
        }
      }

      // ── Preferences ──
      item {
        Text(
          "PREFERENCES",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
      item {
        Column(modifier = Modifier.settingsRowModifier()) {
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Prevent Sleep", style = mobileHeadline) },
            supportingContent = { Text("Keep screen awake while open.", style = mobileCallout) },
            trailingContent = { Switch(checked = preventSleep, onCheckedChange = viewModel::setPreventSleep) },
          )
          HorizontalDivider(color = mobileBorder)
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Debug Canvas", style = mobileHeadline) },
            supportingContent = { Text("Show status overlay on canvas.", style = mobileCallout) },
            trailingContent = {
              Switch(
                checked = canvasDebugStatusEnabled,
                onCheckedChange = viewModel::setCanvasDebugStatusEnabled,
              )
            },
          )
        }
      }

      item { Spacer(modifier = Modifier.height(24.dp)) }
    }
  }
}

@Composable
private fun settingsTextFieldColors() =
  OutlinedTextFieldDefaults.colors(
    focusedContainerColor = mobileSurface,
    unfocusedContainerColor = mobileSurface,
    focusedBorderColor = mobileAccent,
    unfocusedBorderColor = mobileBorder,
    focusedTextColor = mobileText,
    unfocusedTextColor = mobileText,
    cursorColor = mobileAccent,
  )

@Composable
private fun Modifier.settingsRowModifier() =
  this
    .fillMaxWidth()
    .border(width = 1.dp, color = mobileBorder, shape = RoundedCornerShape(14.dp))
    .background(mobileCardSurface, RoundedCornerShape(14.dp))

@Composable
private fun settingsPrimaryButtonColors() =
  ButtonDefaults.buttonColors(
    containerColor = mobileAccent,
    contentColor = Color.White,
    disabledContainerColor = mobileAccent.copy(alpha = 0.45f),
    disabledContentColor = Color.White.copy(alpha = 0.9f),
  )

@Composable
private fun settingsDangerButtonColors() =
  ButtonDefaults.buttonColors(
    containerColor = mobileDanger,
    contentColor = Color.White,
    disabledContainerColor = mobileDanger.copy(alpha = 0.45f),
    disabledContentColor = Color.White.copy(alpha = 0.9f),
  )

private fun openAppSettings(context: Context) {
  val intent =
    Intent(
      Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
      Uri.fromParts("package", context.packageName, null),
    )
  context.startActivity(intent)
}

private fun openNotificationListenerSettings(context: Context) {
  val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
  runCatching {
    context.startActivity(intent)
  }.getOrElse {
    openAppSettings(context)
  }
}

private fun hasNotificationsPermission(context: Context): Boolean {
  if (Build.VERSION.SDK_INT < 33) return true
  return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
          PackageManager.PERMISSION_GRANTED
}

private fun isNotificationListenerEnabled(context: Context): Boolean {
  return DeviceNotificationListenerService.isAccessEnabled(context)
}

private fun hasMotionCapabilities(context: Context): Boolean {
  val sensorManager = context.getSystemService(SensorManager::class.java) ?: return false
  return sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null ||
          sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null
}
