package ai.openclaw.android.ui

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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
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
import androidx.compose.ui.draw.alpha
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
import ai.openclaw.android.BuildConfig
import ai.openclaw.android.LocationMode
import ai.openclaw.android.MainViewModel
import ai.openclaw.android.node.DeviceNotificationListenerService

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

  var pendingLocationMode by remember { mutableStateOf<LocationMode?>(null) }
  var pendingPreciseToggle by remember { mutableStateOf(false) }

  val locationPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
      val fineOk = perms[Manifest.permission.ACCESS_FINE_LOCATION] == true
      val coarseOk = perms[Manifest.permission.ACCESS_COARSE_LOCATION] == true
      val granted = fineOk || coarseOk
      val requestedMode = pendingLocationMode
      pendingLocationMode = null

      if (pendingPreciseToggle) {
        pendingPreciseToggle = false
        viewModel.setLocationPreciseEnabled(fineOk)
        return@rememberLauncherForActivityResult
      }

      if (!granted) {
        viewModel.setLocationMode(LocationMode.Off)
        return@rememberLauncherForActivityResult
      }

      if (requestedMode != null) {
        viewModel.setLocationMode(requestedMode)
        if (requestedMode == LocationMode.Always) {
          val backgroundOk =
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
              PackageManager.PERMISSION_GRANTED
          if (!backgroundOk) {
            openAppSettings(context)
          }
        }
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
      context.packageManager?.hasSystemFeature(PackageManager.FEATURE_TELEPHONY) == true
    }
  val photosPermission =
    if (Build.VERSION.SDK_INT >= 33) {
      Manifest.permission.READ_MEDIA_IMAGES
    } else {
      Manifest.permission.READ_EXTERNAL_STORAGE
    }
  val motionPermissionRequired = Build.VERSION.SDK_INT >= 29
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

  var appUpdateInstallEnabled by
    remember {
      mutableStateOf(canInstallUnknownApps(context))
    }

  var smsPermissionGranted by
    remember {
      mutableStateOf(
        ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) ==
          PackageManager.PERMISSION_GRANTED,
      )
    }
  val smsPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      smsPermissionGranted = granted
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
          motionPermissionGranted =
            !motionPermissionRequired ||
              ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) ==
              PackageManager.PERMISSION_GRANTED
          appUpdateInstallEnabled = canInstallUnknownApps(context)
          smsPermissionGranted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) ==
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

  fun requestLocationPermissions(targetMode: LocationMode) {
    val fineOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val coarseOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (fineOk || coarseOk) {
      viewModel.setLocationMode(targetMode)
      if (targetMode == LocationMode.Always) {
        val backgroundOk =
          ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        if (!backgroundOk) {
          openAppSettings(context)
        }
      }
    } else {
      pendingLocationMode = targetMode
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
      item {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Text(
            "SETTINGS",
            style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
            color = mobileAccent,
          )
          Text("Device Configuration", style = mobileTitle2, color = mobileText)
          Text(
            "Manage capabilities, permissions, and diagnostics.",
            style = mobileCallout,
            color = mobileTextSecondary,
          )
        }
      }
      item { HorizontalDivider(color = mobileBorder) }

    // Order parity: Node → Voice → Camera → Messaging → Location → Screen.
      item {
        Text(
          "NODE",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
    item {
      OutlinedTextField(
        value = displayName,
        onValueChange = viewModel::setDisplayName,
        label = { Text("Name", style = mobileCaption1, color = mobileTextSecondary) },
        modifier = Modifier.fillMaxWidth(),
        textStyle = mobileBody.copy(color = mobileText),
        colors = settingsTextFieldColors(),
      )
    }
      item { Text("Instance ID: $instanceId", style = mobileCallout.copy(fontFamily = FontFamily.Monospace), color = mobileTextSecondary) }
      item { Text("Device: $deviceModel", style = mobileCallout, color = mobileTextSecondary) }
      item { Text("Version: $appVersion", style = mobileCallout, color = mobileTextSecondary) }

      item { HorizontalDivider(color = mobileBorder) }

      // Voice
      item {
        Text(
          "VOICE",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
      item {
        ListItem(
          modifier = settingsRowModifier(),
          colors = listItemColors,
          headlineContent = { Text("Microphone permission", style = mobileHeadline) },
          supportingContent = {
            Text(
              if (micPermissionGranted) {
                "Granted. Use the Voice tab mic button to capture transcript."
              } else {
                "Required for Voice tab transcription."
              },
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
      }
      item {
        Text(
          "Voice wake and talk modes were removed. Voice now uses one mic on/off flow in the Voice tab.",
          style = mobileCallout,
          color = mobileTextSecondary,
        )
      }

      item { HorizontalDivider(color = mobileBorder) }

    // Camera
      item {
        Text(
          "CAMERA",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
    item {
      ListItem(
        modifier = settingsRowModifier(),
        colors = listItemColors,
        headlineContent = { Text("Allow Camera", style = mobileHeadline) },
        supportingContent = { Text("Allows the gateway to request photos or short video clips (foreground only).", style = mobileCallout) },
        trailingContent = { Switch(checked = cameraEnabled, onCheckedChange = ::setCameraEnabledChecked) },
      )
    }
    item {
      Text(
        "Tip: grant Microphone permission for video clips with audio.",
        style = mobileCallout,
        color = mobileTextSecondary,
      )
    }

      item { HorizontalDivider(color = mobileBorder) }

    // Messaging
      item {
        Text(
          "MESSAGING",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
    item {
      val buttonLabel =
        when {
          !smsPermissionAvailable -> "Unavailable"
          smsPermissionGranted -> "Manage"
          else -> "Grant"
        }
      ListItem(
        modifier = settingsRowModifier(),
        colors = listItemColors,
        headlineContent = { Text("SMS Permission", style = mobileHeadline) },
        supportingContent = {
          Text(
            if (smsPermissionAvailable) {
              "Allow the gateway to send SMS from this device."
            } else {
              "SMS requires a device with telephony hardware."
            },
            style = mobileCallout,
          )
        },
        trailingContent = {
          Button(
            onClick = {
              if (!smsPermissionAvailable) return@Button
              if (smsPermissionGranted) {
                openAppSettings(context)
              } else {
                smsPermissionLauncher.launch(Manifest.permission.SEND_SMS)
              }
            },
            enabled = smsPermissionAvailable,
            colors = settingsPrimaryButtonColors(),
            shape = RoundedCornerShape(14.dp),
          ) {
            Text(buttonLabel, style = mobileCallout.copy(fontWeight = FontWeight.Bold))
          }
        },
      )
    }

      item { HorizontalDivider(color = mobileBorder) }

    // Notifications
      item {
        Text(
          "NOTIFICATIONS",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
      item {
        val buttonLabel =
          if (notificationsPermissionGranted) {
            "Manage"
          } else {
            "Grant"
          }
        ListItem(
          modifier = settingsRowModifier(),
          colors = listItemColors,
          headlineContent = { Text("System Notifications", style = mobileHeadline) },
          supportingContent = {
            Text(
              "Required for `system.notify` and Android foreground service alerts.",
              style = mobileCallout,
            )
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
              Text(buttonLabel, style = mobileCallout.copy(fontWeight = FontWeight.Bold))
            }
          },
        )
      }
      item {
        ListItem(
          modifier = settingsRowModifier(),
          colors = listItemColors,
          headlineContent = { Text("Notification Listener Access", style = mobileHeadline) },
          supportingContent = {
            Text(
              "Required for `notifications.list` and `notifications.actions`.",
              style = mobileCallout,
            )
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
      }
      item { HorizontalDivider(color = mobileBorder) }

    // Data access
      item {
        Text(
          "DATA ACCESS",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
      item {
        ListItem(
          modifier = settingsRowModifier(),
          colors = listItemColors,
          headlineContent = { Text("Photos Permission", style = mobileHeadline) },
          supportingContent = {
            Text(
              "Required for `photos.latest`.",
              style = mobileCallout,
            )
          },
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
      }
      item {
        ListItem(
          modifier = settingsRowModifier(),
          colors = listItemColors,
          headlineContent = { Text("Contacts Permission", style = mobileHeadline) },
          supportingContent = {
            Text(
              "Required for `contacts.search` and `contacts.add`.",
              style = mobileCallout,
            )
          },
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
      }
      item {
        ListItem(
          modifier = settingsRowModifier(),
          colors = listItemColors,
          headlineContent = { Text("Calendar Permission", style = mobileHeadline) },
          supportingContent = {
            Text(
              "Required for `calendar.events` and `calendar.add`.",
              style = mobileCallout,
            )
          },
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
      }
      item {
        val motionButtonLabel =
          when {
            !motionAvailable -> "Unavailable"
            !motionPermissionRequired -> "Manage"
            motionPermissionGranted -> "Manage"
            else -> "Grant"
          }
        ListItem(
          modifier = settingsRowModifier(),
          colors = listItemColors,
          headlineContent = { Text("Motion Permission", style = mobileHeadline) },
          supportingContent = {
            Text(
              if (!motionAvailable) {
                "This device does not expose accelerometer or step-counter motion sensors."
              } else {
                "Required for `motion.activity` and `motion.pedometer`."
              },
              style = mobileCallout,
            )
          },
          trailingContent = {
            Button(
              onClick = {
                if (!motionAvailable) return@Button
                if (!motionPermissionRequired || motionPermissionGranted) {
                  openAppSettings(context)
                } else {
                  motionPermissionLauncher.launch(Manifest.permission.ACTIVITY_RECOGNITION)
                }
              },
              enabled = motionAvailable,
              colors = settingsPrimaryButtonColors(),
              shape = RoundedCornerShape(14.dp),
            ) {
              Text(motionButtonLabel, style = mobileCallout.copy(fontWeight = FontWeight.Bold))
            }
          },
        )
      }
      item { HorizontalDivider(color = mobileBorder) }

    // System
      item {
        Text(
          "SYSTEM",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
      item {
        ListItem(
          modifier = settingsRowModifier(),
          colors = listItemColors,
          headlineContent = { Text("Install App Updates", style = mobileHeadline) },
          supportingContent = {
            Text(
              "Enable install access for `app.update` package installs.",
              style = mobileCallout,
            )
          },
          trailingContent = {
            Button(
              onClick = { openUnknownAppSourcesSettings(context) },
              colors = settingsPrimaryButtonColors(),
              shape = RoundedCornerShape(14.dp),
            ) {
              Text(
                if (appUpdateInstallEnabled) "Manage" else "Enable",
                style = mobileCallout.copy(fontWeight = FontWeight.Bold),
              )
            }
          },
        )
      }
      item { HorizontalDivider(color = mobileBorder) }

    // Location
      item {
        Text(
          "LOCATION",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
      item {
        Column(modifier = settingsRowModifier(), verticalArrangement = Arrangement.spacedBy(0.dp)) {
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
                onClick = { requestLocationPermissions(LocationMode.WhileUsing) },
              )
            },
          )
          HorizontalDivider(color = mobileBorder)
          ListItem(
            modifier = Modifier.fillMaxWidth(),
            colors = listItemColors,
            headlineContent = { Text("Always", style = mobileHeadline) },
            supportingContent = { Text("Allow background location (requires system permission).", style = mobileCallout) },
            trailingContent = {
              RadioButton(
                selected = locationMode == LocationMode.Always,
                onClick = { requestLocationPermissions(LocationMode.Always) },
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
    item {
      Text(
        "Always may require Android Settings to allow background location.",
        style = mobileCallout,
        color = mobileTextSecondary,
      )
    }

      item { HorizontalDivider(color = mobileBorder) }

    // Screen
      item {
        Text(
          "SCREEN",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
    item {
      ListItem(
        modifier = settingsRowModifier(),
        colors = listItemColors,
        headlineContent = { Text("Prevent Sleep", style = mobileHeadline) },
        supportingContent = { Text("Keeps the screen awake while OpenClaw is open.", style = mobileCallout) },
        trailingContent = { Switch(checked = preventSleep, onCheckedChange = viewModel::setPreventSleep) },
      )
    }

      item { HorizontalDivider(color = mobileBorder) }

    // Debug
      item {
        Text(
          "DEBUG",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
      }
    item {
      ListItem(
        modifier = settingsRowModifier(),
        colors = listItemColors,
        headlineContent = { Text("Debug Canvas Status", style = mobileHeadline) },
        supportingContent = { Text("Show status text in the canvas when debug is enabled.", style = mobileCallout) },
        trailingContent = {
          Switch(
            checked = canvasDebugStatusEnabled,
            onCheckedChange = viewModel::setCanvasDebugStatusEnabled,
          )
        },
      )
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

private fun settingsRowModifier() =
  Modifier
    .fillMaxWidth()
    .border(width = 1.dp, color = mobileBorder, shape = RoundedCornerShape(14.dp))
    .background(Color.White, RoundedCornerShape(14.dp))

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

private fun openUnknownAppSourcesSettings(context: Context) {
  if (Build.VERSION.SDK_INT < 26) {
    openAppSettings(context)
    return
  }
  val intent =
    Intent(
      Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
      Uri.parse("package:${context.packageName}"),
    )
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

private fun canInstallUnknownApps(context: Context): Boolean {
  if (Build.VERSION.SDK_INT < 26) return true
  return context.packageManager.canRequestPackageInstalls()
}

private fun hasMotionCapabilities(context: Context): Boolean {
  val sensorManager = context.getSystemService(SensorManager::class.java) ?: return false
  return sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null ||
    sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null
}
