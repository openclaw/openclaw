import OpenClawKit
import SwiftUI

extension SettingsProTab {
    var voiceWakeSettingsCard: some View {
        settingsGroupedCard {
            self.settingsGroupedRowPadding {
                Toggle("Voice Wake", isOn: self.$voiceWakeEnabled)
                    .onChange(of: self.voiceWakeEnabled) { _, enabled in
                        self.appModel.setVoiceWakeEnabled(enabled)
                    }
            }
            self.settingsGroupedDivider()
            self.settingsNavigationLinkRow(
                title: "Wake Words",
                value: VoiceWakePreferences.displayString(for: self.voiceWake.triggerWords))
            {
                VoiceWakeWordsSettingsView()
            }
        }
    }

    var talkExperienceSettingsCard: some View {
        settingsGroupedCard {
            self.settingsNavigationLinkRow(
                title: "Call Background",
                value: TalkWallpaperStore.selection().label)
            {
                TalkBackgroundSettingsView()
            }
            self.settingsGroupedDivider()
            self.settingsGroupedPickerRow(label: "Languages", selection: self.$talkSpeechLocale) {
                ForEach(TalkSpeechLocale.supportedOptions()) { option in
                    Text(option.label).tag(option.id)
                }
            }
        }
    }

    var talkGatewayVoiceSettingsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            if self.gatewayConnected,
               let issue = self.appModel.talkMode.gatewayTalkCurrentFallbackIssue
            {
                TalkRuntimeIssueBanner(
                    issue: issue,
                    onOpenSettings: nil,
                    onShowDetails: {
                        self.showTalkIssueDetails = true
                    })
                    .padding(.horizontal, OpenClawProMetric.pagePadding)
            }

            self.settingsGroupedCard {
                self.settingsGroupedRowPadding {
                    Picker("Provider", selection: self.talkProviderSelectionBinding) {
                        ForEach(TalkModeProviderSelection.allCases) { option in
                            Text(option.label).tag(option.rawValue)
                        }
                    }
                }
                if self.shouldShowRealtimeVoicePicker {
                    self.settingsGroupedDivider()
                    self.settingsGroupedPickerRow(
                        label: "Gateway",
                        selection: self.talkRealtimeVoiceSelectionBinding)
                    {
                        Text("Default").tag("")
                        ForEach(TalkModeRealtimeVoiceSelection.voices, id: \.self) { voice in
                            Text(TalkModeRealtimeVoiceSelection.label(for: voice)).tag(voice)
                        }
                    }
                }
                self.settingsGroupedDivider()
                self.detailRow("Voice Mode", value: self.appModel.talkMode.gatewayTalkVoiceModeTitle)
                self.settingsGroupedDivider()
                self.detailRow("Active Voice", value: self.gatewayTalkActiveVoiceDetail)
                if let issue = self.gatewayTalkLastIssueDetail {
                    self.settingsGroupedDivider()
                    self.detailRow("Last Voice Issue", value: issue)
                }
                self.settingsGroupedDivider()
                self.detailRow("Transport", value: self.appModel.talkMode.gatewayTalkTransportLabel)
                self.settingsGroupedDivider()
                self.detailRow("API Key", value: self.talkApiKeyStatus)
            }
        }
    }
}
