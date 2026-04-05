import Foundation

// Stable identifier used for both the macOS LaunchAgent label and Nix-managed defaults suite.
// nix-mullusi writes app defaults into this suite to survive app bundle identifier churn.
let launchdLabel = "ai.mullusi.mac"
let gatewayLaunchdLabel = "ai.mullusi.gateway"
let onboardingVersionKey = "mullusi.onboardingVersion"
let onboardingSeenKey = "mullusi.onboardingSeen"
let currentOnboardingVersion = 7
let pauseDefaultsKey = "mullusi.pauseEnabled"
let iconAnimationsEnabledKey = "mullusi.iconAnimationsEnabled"
let swabbleEnabledKey = "mullusi.swabbleEnabled"
let swabbleTriggersKey = "mullusi.swabbleTriggers"
let voiceWakeTriggerChimeKey = "mullusi.voiceWakeTriggerChime"
let voiceWakeSendChimeKey = "mullusi.voiceWakeSendChime"
let showDockIconKey = "mullusi.showDockIcon"
let defaultVoiceWakeTriggers = ["mullusi"]
let voiceWakeMaxWords = 32
let voiceWakeMaxWordLength = 64
let voiceWakeMicKey = "mullusi.voiceWakeMicID"
let voiceWakeMicNameKey = "mullusi.voiceWakeMicName"
let voiceWakeLocaleKey = "mullusi.voiceWakeLocaleID"
let voiceWakeAdditionalLocalesKey = "mullusi.voiceWakeAdditionalLocaleIDs"
let voicePushToTalkEnabledKey = "mullusi.voicePushToTalkEnabled"
let voiceWakeTriggersTalkModeKey = "mullusi.voiceWakeTriggersTalkMode"
let talkEnabledKey = "mullusi.talkEnabled"
let iconOverrideKey = "mullusi.iconOverride"
let connectionModeKey = "mullusi.connectionMode"
let remoteTargetKey = "mullusi.remoteTarget"
let remoteIdentityKey = "mullusi.remoteIdentity"
let remoteProjectRootKey = "mullusi.remoteProjectRoot"
let remoteCliPathKey = "mullusi.remoteCliPath"
let canvasEnabledKey = "mullusi.canvasEnabled"
let cameraEnabledKey = "mullusi.cameraEnabled"
let systemRunPolicyKey = "mullusi.systemRunPolicy"
let systemRunAllowlistKey = "mullusi.systemRunAllowlist"
let systemRunEnabledKey = "mullusi.systemRunEnabled"
let locationModeKey = "mullusi.locationMode"
let locationPreciseKey = "mullusi.locationPreciseEnabled"
let peekabooBridgeEnabledKey = "mullusi.peekabooBridgeEnabled"
let deepLinkKeyKey = "mullusi.deepLinkKey"
let modelCatalogPathKey = "mullusi.modelCatalogPath"
let modelCatalogReloadKey = "mullusi.modelCatalogReload"
let cliInstallPromptedVersionKey = "mullusi.cliInstallPromptedVersion"
let heartbeatsEnabledKey = "mullusi.heartbeatsEnabled"
let debugPaneEnabledKey = "mullusi.debugPaneEnabled"
let debugFileLogEnabledKey = "mullusi.debug.fileLogEnabled"
let appLogLevelKey = "mullusi.debug.appLogLevel"
let voiceWakeSupported: Bool = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
