import Foundation

let serviceName = "com.steipete.clawdis.xpc"
let launchdLabel = "com.steipete.clawdis"
let onboardingVersionKey = "clawdis.onboardingVersion"
let currentOnboardingVersion = 2
let pauseDefaultsKey = "clawdis.pauseEnabled"
let iconAnimationsEnabledKey = "clawdis.iconAnimationsEnabled"
let swabbleEnabledKey = "clawdis.swabbleEnabled"
let swabbleTriggersKey = "clawdis.swabbleTriggers"
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
let modelCatalogPathKey = "clawdis.modelCatalogPath"
let modelCatalogReloadKey = "clawdis.modelCatalogReload"
let voiceWakeSupported: Bool = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
let cliHelperSearchPaths = ["/usr/local/bin", "/opt/homebrew/bin"]
let defaultVoiceWakeForwardCommand = "clawdis-mac agent --message \"${text}\" --thinking low"
let defaultVoiceWakeForwardPort = 22
let defaultVoiceWakeForwardTimeout: TimeInterval = 6
