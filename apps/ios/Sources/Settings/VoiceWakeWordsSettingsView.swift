import SwiftUI

struct VoiceWakeWordsSettingsView: View {
    @State private var triggerWords: [String] = []

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
                    "Clawdis reacts when any trigger appears in a transcription. "
                        + "Keep them short to avoid false positives.")
            }
        }
        .navigationTitle("Wake Words")
        .toolbar { EditButton() }
        .task {
            if self.triggerWords.isEmpty {
                self.triggerWords = VoiceWakePreferences.loadTriggerWords()
            }
        }
        .onChange(of: self.triggerWords) { _, newValue in
            VoiceWakePreferences.saveTriggerWords(newValue)
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
