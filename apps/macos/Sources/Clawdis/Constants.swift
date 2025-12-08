import Foundation

let serviceName = "com.steipete.clawdis.xpc"
let launchdLabel = "com.steipete.clawdis"
let onboardingVersionKey = "clawdis.onboardingVersion"
let currentOnboardingVersion = 3
let pauseDefaultsKey = "clawdis.pauseEnabled"
let iconAnimationsEnabledKey = "clawdis.iconAnimationsEnabled"
let swabbleEnabledKey = "clawdis.swabbleEnabled"
let swabbleTriggersKey = "clawdis.swabbleTriggers"
let voiceWakeTriggerChimeKey = "clawdis.voiceWakeTriggerChime"
let voiceWakeSendChimeKey = "clawdis.voiceWakeSendChime"
let showDockIconKey = "clawdis.showDockIcon"
let defaultVoiceWakeTriggers = ["clawd", "claude"]
let voiceWakeMicKey = "clawdis.voiceWakeMicID"
let voiceWakeLocaleKey = "clawdis.voiceWakeLocaleID"
let voiceWakeAdditionalLocalesKey = "clawdis.voiceWakeAdditionalLocaleIDs"
let voiceWakeForwardEnabledKey = "clawdis.voiceWakeForwardEnabled"
let voiceWakeForwardTargetKey = "clawdis.voiceWakeForwardTarget"
let voiceWakeForwardHostKey = "clawdis.voiceWakeForwardHost"
let voiceWakeForwardUserKey = "clawdis.voiceWakeForwardUser"
let voiceWakeForwardPortKey = "clawdis.voiceWakeForwardPort"
let voiceWakeForwardIdentityKey = "clawdis.voiceWakeForwardIdentity"
let voiceWakeForwardCommandKey = "clawdis.voiceWakeForwardCommand"
let voicePushToTalkEnabledKey = "clawdis.voicePushToTalkEnabled"
let connectionModeKey = "clawdis.connectionMode"
let remoteTargetKey = "clawdis.remoteTarget"
let remoteIdentityKey = "clawdis.remoteIdentity"
let remoteProjectRootKey = "clawdis.remoteProjectRoot"
let webChatEnabledKey = "clawdis.webChatEnabled"
let webChatPortKey = "clawdis.webChatPort"
let modelCatalogPathKey = "clawdis.modelCatalogPath"
let modelCatalogReloadKey = "clawdis.modelCatalogReload"
let heartbeatsEnabledKey = "clawdis.heartbeatsEnabled"
let voiceWakeSupported: Bool = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
let cliHelperSearchPaths = ["/usr/local/bin", "/opt/homebrew/bin"]
let defaultVoiceWakeForwardCommand = "clawdis-mac agent --message \"${text}\" --thinking low --session main --deliver"
let defaultVoiceWakeForwardPort = 22
// Allow enough time for remote agent responses (LLM replies often take >10s).
let defaultVoiceWakeForwardTimeout: TimeInterval = 30
