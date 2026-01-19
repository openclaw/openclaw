import SwiftUI

struct VoiceWakeWordsSettingsView: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var triggerWords: [String] = VoiceWakePreferences.loadTriggerWords()
    @State private var syncTask: Task<Void, Never>?

    var body: some View {
        Form {
            Section {
                ForEach(self.triggerWords.indices, id: \.self) { index in
                    TextField("Wake word", text: self.binding(for: index))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .onDelete(perform: self.removeWords)

                Button {
                    self.addWord()
                } label: {
                    Label("Add word", systemImage: "plus")
                }
                .disabled(self.triggerWords
                    .contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }))

                Button("Reset defaults") {
                    self.triggerWords = VoiceWakePreferences.defaultTriggerWords
                }
            } header: {
                Text("Wake Words")
            } footer: {
                Text(
                    "Clawdbot reacts when any trigger appears in a transcription. "
                        + "Keep them short to avoid false positives.")
            }
        }
        .navigationTitle("Wake Words")
        .toolbar { EditButton() }
        .onAppear {
            if self.triggerWords.isEmpty {
                self.triggerWords = VoiceWakePreferences.defaultTriggerWords
            }
        }
        .onChange(of: self.triggerWords) { _, newValue in
            // Keep local voice wake responsive even if the gateway isn't connected yet.
            VoiceWakePreferences.saveTriggerWords(newValue)

            let snapshot = VoiceWakePreferences.sanitizeTriggerWords(newValue)
            self.syncTask?.cancel()
            self.syncTask = Task { [snapshot, weak appModel = self.appModel] in
                try? await Task.sleep(nanoseconds: 650_000_000)
                await appModel?.setGlobalWakeWords(snapshot)
            }
        }
    }

    private func addWord() {
        self.triggerWords.append("")
    }

    private func removeWords(at offsets: IndexSet) {
        self.triggerWords.remove(atOffsets: offsets)
        if self.triggerWords.isEmpty {
            self.triggerWords = VoiceWakePreferences.defaultTriggerWords
        }
    }

    private func binding(for index: Int) -> Binding<String> {
        Binding(
            get: {
                guard self.triggerWords.indices.contains(index) else { return "" }
                return self.triggerWords[index]
            },
            set: { newValue in
                guard self.triggerWords.indices.contains(index) else { return }
                self.triggerWords[index] = newValue
            })
    }
}
