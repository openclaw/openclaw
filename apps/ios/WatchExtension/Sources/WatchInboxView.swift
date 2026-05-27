import SwiftUI

struct WatchInboxView: View {
    @Bindable var store: WatchInboxStore
    var onAction: ((WatchPromptAction) -> Void)?

    private func role(for action: WatchPromptAction) -> ButtonRole? {
        switch action.style?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "destructive":
            return .destructive
        case "cancel":
            return .cancel
        default:
            return nil
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(store.title)
                    .font(.headline)
                    .lineLimit(2)

                Text(store.body)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)

                if let details = store.details, !details.isEmpty {
                    Text(details)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !store.actions.isEmpty {
                    ForEach(store.actions) { action in
                        Button(role: self.role(for: action)) {
                            self.onAction?(action)
                        } label: {
                            Text(action.label)
                                .frame(maxWidth: .infinity)
                        }
                        .disabled(store.isReplySending)
                    }
                }

                if let replyStatusText = store.replyStatusText, !replyStatusText.isEmpty {
                    Text(replyStatusText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let updatedAt = store.updatedAt {
                    Text("Updated \(updatedAt.formatted(date: .omitted, time: .shortened))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
    }
}
