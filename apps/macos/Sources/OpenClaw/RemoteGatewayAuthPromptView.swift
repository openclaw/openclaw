import SwiftUI

struct RemoteGatewayAuthPromptView: View {
    let issue: RemoteGatewayAuthIssue

    var body: some View {
        let promptStyle = Self.promptStyle(for: self.issue)
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: promptStyle.systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(promptStyle.tint)
                .frame(width: 16, alignment: .center)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text(self.issue.title)
                    .font(.caption.weight(.semibold))
                Text(.init(self.issue.body))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let footnote = self.issue.footnote {
                    Text(.init(footnote))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    static func promptStyle(
        for issue: RemoteGatewayAuthIssue)
        -> (systemImage: String, tint: Color)
    {
        switch issue {
        case .tokenRequired:
            ("key.fill", .orange)
        case .tokenMismatch:
            ("exclamationmark.triangle.fill", .orange)
        case .gatewayTokenNotConfigured:
            ("wrench.and.screwdriver.fill", .orange)
        case .setupCodeExpired:
            ("qrcode.viewfinder", .orange)
        case .passwordRequired:
            ("lock.slash.fill", .orange)
        case .pairingRequired:
            ("link.badge.plus", .orange)
        }
    }
}
