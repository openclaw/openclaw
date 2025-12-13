import SwiftUI

struct VoiceTab: View {
    @EnvironmentObject private var appModel: NodeAppModel
    @EnvironmentObject private var voiceWake: VoiceWakeManager
    @AppStorage("voiceWake.enabled") private var voiceWakeEnabled: Bool = false

    var body: some View {
        NavigationStack {
            List {
                Section("Status") {
                    LabeledContent("Voice Wake", value: self.voiceWakeEnabled ? "Enabled" : "Disabled")
                    LabeledContent("Listener", value: self.voiceWake.isListening ? "Listening" : "Idle")
                    Text(self.voiceWake.statusText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Notes") {
                    let triggers = self.voiceWake.activeTriggerWords
                    Group {
                        if triggers.isEmpty {
                            Text("Add wake words in Settings.")
                        } else if triggers.count == 1 {
                            Text("Say “\(triggers[0]) …” to trigger.")
                        } else if triggers.count == 2 {
                            Text("Say “\(triggers[0]) …” or “\(triggers[1]) …” to trigger.")
                        } else {
                            Text("Say “\(triggers.joined(separator: " …”, “")) …” to trigger.")
                        }
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Voice")
            .onChange(of: self.voiceWakeEnabled) { _, newValue in
                self.appModel.setVoiceWakeEnabled(newValue)
            }
        }
    }
}
