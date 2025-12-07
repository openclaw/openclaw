import SwiftUI

enum VoiceWakeForwardStatus: Equatable {
    case idle
    case checking
    case ok
    case failed(String)
}

struct VoiceWakeForwardSection: View {
    @Binding var enabled: Bool
    @Binding var target: String
    @Binding var identity: String
    @Binding var command: String
    @Binding var showAdvanced: Bool
    @Binding var status: VoiceWakeForwardStatus
    let onTest: () -> Void
    let onChange: () -> Void
    var showToggle: Bool = true
    var title: String = "Forward wake to host (SSH)"
    var subtitle: String = "Send wake transcripts to a remote Clawdis host."

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if self.showToggle {
                Toggle(isOn: self.$enabled) {
                    Text(self.title)
                }
            } else {
                Text(self.title)
                    .font(.callout.weight(.semibold))
                Text(self.subtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if self.enabled {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        Text("SSH")
                            .font(.callout.weight(.semibold))
                            .frame(width: 40, alignment: .leading)
                        TextField("steipete@peters-mac-studio-1", text: self.$target)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: .infinity)
                            .onChange(of: self.target) { _, _ in
                                self.onChange()
                            }
                        self.statusIcon
                            .frame(width: 16, height: 16, alignment: .center)
                        Button("Test") { self.onTest() }
                            .disabled(self.target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }

                    if case let .failed(message) = self.status {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(5)
                    }

                    DisclosureGroup(isExpanded: self.$showAdvanced) {
                        VStack(alignment: .leading, spacing: 10) {
                            LabeledContent("Identity file") {
                                TextField(
                                    "/Users/you/.ssh/voicewake_ed25519",
                                    text: self.$identity)
                                    .textFieldStyle(.roundedBorder)
                                    .frame(width: 320)
                                    .onChange(of: self.identity) { _, _ in
                                        self.onChange()
                                    }
                            }

                            VStack(alignment: .leading, spacing: 4) {
                                Text("Remote command template")
                                    .font(.callout.weight(.semibold))
                                TextField(
                                    "clawdis-mac agent --message \"${text}\" --thinking low",
                                    text: self.$command,
                                    axis: .vertical)
                                    .textFieldStyle(.roundedBorder)
                                    .onChange(of: self.command) { _, _ in
                                        self.onChange()
                                    }
                                Text(
                                    "${text} is replaced with the transcript."
                                        + "\nIt is also piped to stdin if you prefer $(cat).")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(.top, 4)
                    } label: {
                        Text("Advanced")
                            .font(.callout.weight(.semibold))
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var statusIcon: some View {
        Group {
            switch self.status {
            case .idle:
                Image(systemName: "circle.dashed").foregroundStyle(.secondary)
            case .checking:
                ProgressView().controlSize(.mini)
            case .ok:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            case .failed:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
            }
        }
    }
}
