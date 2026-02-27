import Foundation

// Stable identifier used for both the macOS LaunchAgent label and Nix-managed defaults suite.
// nix-bot writes app defaults into this suite to survive app bundle identifier churn.
let launchdLabel = "ai.bot.mac"
let gatewayLaunchdLabel = "ai.bot.gateway"
let onboardingVersionKey = "bot.onboardingVersion"
let onboardingSeenKey = "bot.onboardingSeen"
let currentOnboardingVersion = 7
let pauseDefaultsKey = "bot.pauseEnabled"
let iconAnimationsEnabledKey = "bot.iconAnimationsEnabled"
let swabbleEnabledKey = "bot.swabbleEnabled"
let swabbleTriggersKey = "bot.swabbleTriggers"
let voiceWakeTriggerChimeKey = "bot.voiceWakeTriggerChime"
let voiceWakeSendChimeKey = "bot.voiceWakeSendChime"
let showDockIconKey = "bot.showDockIcon"
let defaultVoiceWakeTriggers = ["hanzo-bot"]
let voiceWakeMaxWords = 32
let voiceWakeMaxWordLength = 64
let voiceWakeMicKey = "bot.voiceWakeMicID"
let voiceWakeMicNameKey = "bot.voiceWakeMicName"
let voiceWakeLocaleKey = "bot.voiceWakeLocaleID"
let voiceWakeAdditionalLocalesKey = "bot.voiceWakeAdditionalLocaleIDs"
let voicePushToTalkEnabledKey = "bot.voicePushToTalkEnabled"
let talkEnabledKey = "bot.talkEnabled"
let iconOverrideKey = "bot.iconOverride"
let connectionModeKey = "bot.connectionMode"
let remoteTargetKey = "bot.remoteTarget"
let remoteIdentityKey = "bot.remoteIdentity"
let remoteProjectRootKey = "bot.remoteProjectRoot"
let remoteCliPathKey = "bot.remoteCliPath"
let canvasEnabledKey = "bot.canvasEnabled"
let cameraEnabledKey = "bot.cameraEnabled"
let systemRunPolicyKey = "bot.systemRunPolicy"
let systemRunAllowlistKey = "bot.systemRunAllowlist"
let systemRunEnabledKey = "bot.systemRunEnabled"
let locationModeKey = "bot.locationMode"
let locationPreciseKey = "bot.locationPreciseEnabled"
let peekabooBridgeEnabledKey = "bot.peekabooBridgeEnabled"
let deepLinkKeyKey = "bot.deepLinkKey"
let modelCatalogPathKey = "bot.modelCatalogPath"
let modelCatalogReloadKey = "bot.modelCatalogReload"
let cliInstallPromptedVersionKey = "bot.cliInstallPromptedVersion"
let heartbeatsEnabledKey = "bot.heartbeatsEnabled"
let debugPaneEnabledKey = "bot.debugPaneEnabled"
let debugFileLogEnabledKey = "bot.debug.fileLogEnabled"
let appLogLevelKey = "bot.debug.appLogLevel"
let voiceWakeSupported: Bool = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
