import SwiftUI

enum NativeChatTextSize: String, CaseIterable, Identifiable {
    case smaller
    case standard
    case larger

    static let storageKey = "chat.textSize"
    var id: String {
        self.rawValue
    }

    var title: LocalizedStringKey {
        switch self {
        case .smaller: "Smaller"
        case .standard: "Default"
        case .larger: "Larger"
        }
    }

    func dynamicTypeSize(relativeTo systemSize: DynamicTypeSize) -> DynamicTypeSize {
        // The in-app density preference must not reduce a system accessibility size.
        guard !systemSize.isAccessibilitySize else { return systemSize }
        let sizes: [DynamicTypeSize] = [.xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge]
        guard let index = sizes.firstIndex(of: systemSize) else { return systemSize }
        let offset = self == .smaller ? -1 : self == .larger ? 1 : 0
        return sizes[min(max(index + offset, 0), sizes.count - 1)]
    }
}

struct ChatTextSizeSettingsView: View {
    @Environment(AppAppearanceModel.self) private var appearanceModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(selection: Binding(
                        get: { self.appearanceModel.chatTextSize },
                        set: { self.appearanceModel.selectChatTextSize($0) }))
                    {
                        ForEach(NativeChatTextSize.allCases) { size in
                            Text(size.title)
                                .font(OpenClawType.body)
                                .tag(size)
                        }
                    } label: {
                        Text("Chat text size")
                            .font(OpenClawType.body)
                    }
                    .pickerStyle(.inline)
                    .accessibilityIdentifier("chat-text-size-picker")
                } footer: {
                    Text("Applies to native chat on this device. System accessibility text sizes take priority.")
                        .font(OpenClawType.footnote)
                }
            }
            .navigationTitle("Chat text size")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        self.dismiss()
                    } label: {
                        Text("Done")
                            .font(OpenClawType.subheadSemiBold)
                    }
                }
            }
        }
    }
}
