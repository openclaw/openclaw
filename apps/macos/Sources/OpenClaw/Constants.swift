import Foundation

// Stable identifier used for both the macOS LaunchAgent label and Nix-managed defaults suite.
// nix-EasyHub writes app defaults into this suite to survive app bundle identifier churn.
let launchdLabel = "ai.EasyHub.mac"
let gatewayLaunchdLabel = "ai.EasyHub.gateway"
let onboardingVersionKey = "EasyHub.onboardingVersion"
let onboardingSeenKey = "EasyHub.onboardingSeen"
let currentOnboardingVersion = 7
let pauseDefaultsKey = "EasyHub.pauseEnabled"
let iconAnimationsEnabledKey = "EasyHub.iconAnimationsEnabled"
let swabbleEnabledKey = "EasyHub.swabbleEnabled"
let swabbleTriggersKey = "EasyHub.swabbleTriggers"
let voiceWakeTriggerChimeKey = "EasyHub.voiceWakeTriggerChime"
let voiceWakeSendChimeKey = "EasyHub.voiceWakeSendChime"
let showDockIconKey = "EasyHub.showDockIcon"
let defaultVoiceWakeTriggers = ["EasyHub"]
let voiceWakeMaxWords = 32
let voiceWakeMaxWordLength = 64
let voiceWakeMicKey = "EasyHub.voiceWakeMicID"
let voiceWakeMicNameKey = "EasyHub.voiceWakeMicName"
let voiceWakeLocaleKey = "EasyHub.voiceWakeLocaleID"
let voiceWakeAdditionalLocalesKey = "EasyHub.voiceWakeAdditionalLocaleIDs"
let voicePushToTalkEnabledKey = "EasyHub.voicePushToTalkEnabled"
let talkEnabledKey = "EasyHub.talkEnabled"
let iconOverrideKey = "EasyHub.iconOverride"
let connectionModeKey = "EasyHub.connectionMode"
let remoteTargetKey = "EasyHub.remoteTarget"
let remoteIdentityKey = "EasyHub.remoteIdentity"
let remoteProjectRootKey = "EasyHub.remoteProjectRoot"
let remoteCliPathKey = "EasyHub.remoteCliPath"
let canvasEnabledKey = "EasyHub.canvasEnabled"
let cameraEnabledKey = "EasyHub.cameraEnabled"
let systemRunPolicyKey = "EasyHub.systemRunPolicy"
let systemRunAllowlistKey = "EasyHub.systemRunAllowlist"
let systemRunEnabledKey = "EasyHub.systemRunEnabled"
let locationModeKey = "EasyHub.locationMode"
let locationPreciseKey = "EasyHub.locationPreciseEnabled"
let peekabooBridgeEnabledKey = "EasyHub.peekabooBridgeEnabled"
let deepLinkKeyKey = "EasyHub.deepLinkKey"
let modelCatalogPathKey = "EasyHub.modelCatalogPath"
let modelCatalogReloadKey = "EasyHub.modelCatalogReload"
let cliInstallPromptedVersionKey = "EasyHub.cliInstallPromptedVersion"
let heartbeatsEnabledKey = "EasyHub.heartbeatsEnabled"
let debugPaneEnabledKey = "EasyHub.debugPaneEnabled"
let debugFileLogEnabledKey = "EasyHub.debug.fileLogEnabled"
let appLogLevelKey = "EasyHub.debug.appLogLevel"
let voiceWakeSupported: Bool = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
