import Foundation

// Stable identifier used for both the macOS LaunchAgent label and Nix-managed defaults suite.
// nix-smart-agent-neo writes app defaults into this suite to survive app bundle identifier churn.
let launchdLabel = "ai.smartagentneo.mac"
let gatewayLaunchdLabel = "ai.smartagentneo.gateway"
let onboardingVersionKey = "smart-agent-neo.onboardingVersion"
let onboardingSeenKey = "smart-agent-neo.onboardingSeen"
let currentOnboardingVersion = 7
let pauseDefaultsKey = "smart-agent-neo.pauseEnabled"
let iconAnimationsEnabledKey = "smart-agent-neo.iconAnimationsEnabled"
let swabbleEnabledKey = "smart-agent-neo.swabbleEnabled"
let swabbleTriggersKey = "smart-agent-neo.swabbleTriggers"
let voiceWakeTriggerChimeKey = "smart-agent-neo.voiceWakeTriggerChime"
let voiceWakeSendChimeKey = "smart-agent-neo.voiceWakeSendChime"
let showDockIconKey = "smart-agent-neo.showDockIcon"
let defaultVoiceWakeTriggers = ["smart-agent-neo"]
let voiceWakeMaxWords = 32
let voiceWakeMaxWordLength = 64
let voiceWakeMicKey = "smart-agent-neo.voiceWakeMicID"
let voiceWakeMicNameKey = "smart-agent-neo.voiceWakeMicName"
let voiceWakeLocaleKey = "smart-agent-neo.voiceWakeLocaleID"
let voiceWakeAdditionalLocalesKey = "smart-agent-neo.voiceWakeAdditionalLocaleIDs"
let voicePushToTalkEnabledKey = "smart-agent-neo.voicePushToTalkEnabled"
let talkEnabledKey = "smart-agent-neo.talkEnabled"
let iconOverrideKey = "smart-agent-neo.iconOverride"
let connectionModeKey = "smart-agent-neo.connectionMode"
let remoteTargetKey = "smart-agent-neo.remoteTarget"
let remoteIdentityKey = "smart-agent-neo.remoteIdentity"
let remoteProjectRootKey = "smart-agent-neo.remoteProjectRoot"
let remoteCliPathKey = "smart-agent-neo.remoteCliPath"
let canvasEnabledKey = "smart-agent-neo.canvasEnabled"
let cameraEnabledKey = "smart-agent-neo.cameraEnabled"
let systemRunPolicyKey = "smart-agent-neo.systemRunPolicy"
let systemRunAllowlistKey = "smart-agent-neo.systemRunAllowlist"
let systemRunEnabledKey = "smart-agent-neo.systemRunEnabled"
let locationModeKey = "smart-agent-neo.locationMode"
let locationPreciseKey = "smart-agent-neo.locationPreciseEnabled"
let peekabooBridgeEnabledKey = "smart-agent-neo.peekabooBridgeEnabled"
let deepLinkKeyKey = "smart-agent-neo.deepLinkKey"
let modelCatalogPathKey = "smart-agent-neo.modelCatalogPath"
let modelCatalogReloadKey = "smart-agent-neo.modelCatalogReload"
let cliInstallPromptedVersionKey = "smart-agent-neo.cliInstallPromptedVersion"
let heartbeatsEnabledKey = "smart-agent-neo.heartbeatsEnabled"
let debugPaneEnabledKey = "smart-agent-neo.debugPaneEnabled"
let debugFileLogEnabledKey = "smart-agent-neo.debug.fileLogEnabled"
let appLogLevelKey = "smart-agent-neo.debug.appLogLevel"
let voiceWakeSupported: Bool = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
