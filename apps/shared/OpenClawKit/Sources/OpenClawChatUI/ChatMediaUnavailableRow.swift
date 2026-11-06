import SwiftUI

struct ChatMediaUnavailableRow: View {
    let systemImage: String
    let message: String
    var minimumHeight: CGFloat?
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: self.systemImage)
            Text(self.message)
                .font(OpenClawChatTypography.footnote)
            Spacer()
            Button(action: self.retry) {
                Text(String(localized: "Retry"))
                    .font(OpenClawChatTypography.footnote)
            }
            .buttonStyle(.plain)
        }
        .foregroundStyle(.secondary)
        .padding(10)
        .frame(minHeight: self.minimumHeight)
        .background(Color.black.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
