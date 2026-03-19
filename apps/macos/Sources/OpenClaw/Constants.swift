import Foundation

private var defaultsPrefix: String { AppFlavor.current.defaultsPrefix }

// Stable identifier used for both the macOS LaunchAgent label and Nix-managed defaults suite.
// Consumer builds use a separate suite so they can coexist with the founder app on one Mac.
var launchdLabel: String { AppFlavor.current.stableSuiteName }
var gatewayLaunchdLabel: String { AppFlavor.current.gatewayLaunchLabel }
var onboardingVersionKey: String { "\(defaultsPrefix).onboardingVersion" }
var onboardingSeenKey: String { "\(defaultsPrefix).onboardingSeen" }
let currentOnboardingVersion = 7
var pauseDefaultsKey: String { "\(defaultsPrefix).pauseEnabled" }
var iconAnimationsEnabledKey: String { "\(defaultsPrefix).iconAnimationsEnabled" }
var swabbleEnabledKey: String { "\(defaultsPrefix).swabbleEnabled" }
var swabbleTriggersKey: String { "\(defaultsPrefix).swabbleTriggers" }
var voiceWakeTriggerChimeKey: String { "\(defaultsPrefix).voiceWakeTriggerChime" }
var voiceWakeSendChimeKey: String { "\(defaultsPrefix).voiceWakeSendChime" }
var showDockIconKey: String { "\(defaultsPrefix).showDockIcon" }
let defaultVoiceWakeTriggers = ["openclaw"]
let voiceWakeMaxWords = 32
let voiceWakeMaxWordLength = 64
var voiceWakeMicKey: String { "\(defaultsPrefix).voiceWakeMicID" }
var voiceWakeMicNameKey: String { "\(defaultsPrefix).voiceWakeMicName" }
var voiceWakeLocaleKey: String { "\(defaultsPrefix).voiceWakeLocaleID" }
var voiceWakeAdditionalLocalesKey: String { "\(defaultsPrefix).voiceWakeAdditionalLocaleIDs" }
var voicePushToTalkEnabledKey: String { "\(defaultsPrefix).voicePushToTalkEnabled" }
var talkEnabledKey: String { "\(defaultsPrefix).talkEnabled" }
var iconOverrideKey: String { "\(defaultsPrefix).iconOverride" }
var connectionModeKey: String { "\(defaultsPrefix).connectionMode" }
var remoteTargetKey: String { "\(defaultsPrefix).remoteTarget" }
var remoteIdentityKey: String { "\(defaultsPrefix).remoteIdentity" }
var remoteProjectRootKey: String { "\(defaultsPrefix).remoteProjectRoot" }
var remoteCliPathKey: String { "\(defaultsPrefix).remoteCliPath" }
var canvasEnabledKey: String { "\(defaultsPrefix).canvasEnabled" }
var cameraEnabledKey: String { "\(defaultsPrefix).cameraEnabled" }
var systemRunPolicyKey: String { "\(defaultsPrefix).systemRunPolicy" }
var systemRunAllowlistKey: String { "\(defaultsPrefix).systemRunAllowlist" }
var systemRunEnabledKey: String { "\(defaultsPrefix).systemRunEnabled" }
var locationModeKey: String { "\(defaultsPrefix).locationMode" }
var locationPreciseKey: String { "\(defaultsPrefix).locationPreciseEnabled" }
var peekabooBridgeEnabledKey: String { "\(defaultsPrefix).peekabooBridgeEnabled" }
var deepLinkKeyKey: String { "\(defaultsPrefix).deepLinkKey" }
var modelCatalogPathKey: String { "\(defaultsPrefix).modelCatalogPath" }
var modelCatalogReloadKey: String { "\(defaultsPrefix).modelCatalogReload" }
var cliInstallPromptedVersionKey: String { "\(defaultsPrefix).cliInstallPromptedVersion" }
var heartbeatsEnabledKey: String { "\(defaultsPrefix).heartbeatsEnabled" }
var debugPaneEnabledKey: String { "\(defaultsPrefix).debugPaneEnabled" }
var debugFileLogEnabledKey: String { "\(defaultsPrefix).debug.fileLogEnabled" }
var appLogLevelKey: String { "\(defaultsPrefix).debug.appLogLevel" }
var showAdvancedSettingsKey: String { "\(defaultsPrefix).showAdvancedSettings" }
let voiceWakeSupported: Bool = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
