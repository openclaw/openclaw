package ai.openclaw.app.ui

import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.ui.design.ClawIcons
import androidx.compose.ui.graphics.vector.ImageVector

internal enum class SettingsCategory(
  val title: NativeText,
) {
  Personal(nativeText("Profile & appearance")),
  Phone(nativeText("This phone")),
  Connection(nativeText("Connections")),
  Configuration(nativeText("Configuration")),
  System(nativeText("System")),
  Workspace(nativeText("Workspace")),
}

internal enum class SettingsRoute(
  val title: NativeText,
  val icon: ImageVector,
  val category: SettingsCategory?,
) {
  Home(nativeText("Settings"), ClawIcons.Settings, null),
  Profile(nativeText("Profile"), ClawIcons.Profile, SettingsCategory.Personal),
  Voice(nativeText("Voice"), ClawIcons.Mic, SettingsCategory.Phone),
  Agents(nativeText("Agents"), ClawIcons.Agents, SettingsCategory.Workspace),
  ProvidersModels(nativeText("Providers & Models"), ClawIcons.Providers, SettingsCategory.Configuration),
  Approvals(nativeText("Approvals"), ClawIcons.Approvals, SettingsCategory.Configuration),
  CronJobs(nativeText("Automations"), ClawIcons.Automations, SettingsCategory.Workspace),
  Usage(nativeText("Usage"), ClawIcons.Usage, SettingsCategory.Workspace),
  Skills(nativeText("Skills"), ClawIcons.Skills, SettingsCategory.Workspace),
  SystemAgent(nativeText("OpenClaw"), ClawIcons.OpenClaw, null),
  NodesDevices(nativeText("Nodes & Devices"), ClawIcons.Devices, SettingsCategory.Connection),
  Channels(nativeText("Channels"), ClawIcons.Channels, SettingsCategory.Connection),
  Dreaming(nativeText("Dreaming"), ClawIcons.Memory, SettingsCategory.Workspace),
  Terminal(nativeText("Terminal"), ClawIcons.Terminal, SettingsCategory.Workspace),
  Desktop(nativeText("Desktop"), ClawIcons.Desktop, SettingsCategory.Workspace),
  Notifications(nativeText("Notifications"), ClawIcons.Notifications, SettingsCategory.Phone),
  PhoneCapabilities(nativeText("Phone Capabilities"), ClawIcons.Permissions, SettingsCategory.Phone),
  Gateway(nativeText("Gateway"), ClawIcons.Gateway, SettingsCategory.Connection),
  Appearance(nativeText("Appearance"), ClawIcons.Appearance, SettingsCategory.Personal),
  Health(nativeText("Health"), ClawIcons.Health, SettingsCategory.System),
  About(nativeText("About"), ClawIcons.About, SettingsCategory.System),
  Licenses(nativeText("Licenses"), ClawIcons.Licenses, SettingsCategory.System),
  ;

  fun isAvailable(desktopObserveAvailable: Boolean): Boolean = this != Desktop || desktopObserveAvailable
}
