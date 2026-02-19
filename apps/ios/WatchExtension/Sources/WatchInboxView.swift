import SwiftUI

struct WatchInboxView: View {
    @Bindable var store: WatchInboxStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(store.title)
                    .font(.headline)
                    .lineLimit(2)

                Text(store.body)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)

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
