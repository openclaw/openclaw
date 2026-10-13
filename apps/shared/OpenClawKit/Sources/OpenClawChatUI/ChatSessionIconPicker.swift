#if os(macOS)
import OpenClawProtocol
import SwiftUI

struct ChatSessionIconPicker: View {
    let session: OpenClawChatSessionEntry
    let connection: OpenClawSessionMenuConnection
    let viewModel: OpenClawChatViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var custom = ""
    @State private var error: String?
    @State private var saving = false
    @State private var selectedColor: String?
    @State private var selectedIcon: String?

    // ui/src/components/session-icon-picker.ts:13 and session-agent-status.ts:16 define the stored choices.
    private let emoji = ["🦞", "🚀", "🐛", "✅", "🔥", "📦", "🧪", "📝", "🔍", "⚡", "🎯"]
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Icon & color").font(OpenClawChatTypography.headline)
            OpenClawSessionColorMenu(color: self.selectedColor) {
                self.save(["color": $0.map(AnyCodable.init) ?? .init(NSNull())])
            }
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(38)), count: 6)) {
                ForEach(self.emoji, id: \.self) { emoji in
                    Button(emoji) { self.save(["icon": .init(emoji)]) }.font(.title2)
                        .tint(self.selectedIcon == emoji ? OpenClawChatTheme.accent : .primary)
                }
                ForEach(ChatSessionSidebarRowFacts.iconGlyphs, id: \.0) { glyph in
                    Button { self.save(["icon": .init(glyph.0)]) } label: { Image(systemName: glyph.1) }
                        .accessibilityLabel(glyph.0)
                        .tint(self.selectedIcon == glyph.0 ? OpenClawChatTheme.accent : .primary)
                }
                Button { self.save(["icon": .init(NSNull())]) } label: { Image(systemName: "xmark.circle") }
                    .accessibilityLabel("No icon")
            }
            HStack {
                TextField("Custom emoji", text: self.$custom)
                Button("Set") { self.save(["icon": .init(self.custom.trimmingCharacters(in: .whitespacesAndNewlines))])
                }
                .disabled(!Self.acceptsCustomEmoji(self.custom))
            }
            if let error { Text(error).foregroundStyle(OpenClawChatTheme.danger) }
            HStack {
                Button("Reset appearance") { self.save(["icon": .init(NSNull()), "color": .init(NSNull())])
                }
                Spacer()
                Button("Done") { self.dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
        .font(OpenClawChatTypography.body)
        .padding(20)
        .frame(width: 320)
        .disabled(self.saving)
        .onAppear { self.selectedColor = self.session.color
            self.selectedIcon = self.session.icon
        }
    }

    static func acceptsCustomEmoji(_ input: String) -> Bool {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        // session-agent-status.ts:96: clients without Unicode Sets use this grapheme precheck; Gateway validates RGI.
        return value.count == 1 && value.utf16.count <= 16 &&
            !value.unicodeScalars.allSatisfy { (33...126).contains($0.value) }
    }

    private func save(_ fields: [String: AnyCodable]) {
        self.saving = true
        Task {
            defer { self.saving = false }
            do {
                try await self.connection.request(OpenClawChatGatewayRequests.sessionMenu(
                    "sessions.patch", session: self.session, fields: fields))
                self.error = nil
                if let color = fields["color"] { self.selectedColor = color.value as? String }
                if let icon = fields["icon"] { self.selectedIcon = icon.value as? String }
                self.viewModel.refreshSessions()
            } catch { self.error = error.localizedDescription }
        }
    }
}
#endif
