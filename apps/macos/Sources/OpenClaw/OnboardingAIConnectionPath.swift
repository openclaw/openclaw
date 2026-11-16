import SwiftUI

/// Presentation only. The Gateway still owns discovery, downloads, and activation.
enum OnboardingAIConnectionPath {
    case choice
    case account
    case localModel

    static func isModelService(_ modelRef: String) -> Bool {
        // These providers expose model-server setup. Their endpoints may be remote.
        // Unknown/custom routes
        // remain reachable under accounts; never infer locality from a label.
        let provider = modelRef.split(separator: "/", maxSplits: 1).first.map(String.init) ?? ""
        return ["ollama", "lmstudio", "llama-cpp"].contains(provider)
    }
}

struct OnboardingAIPathChoice: View {
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            HStack(spacing: 16) {
                Image(systemName: self.symbol)
                    .font(.title2)
                    .frame(width: 32)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(self.title).font(.headline)
                    Text(self.subtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Image(systemName: "chevron.right")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .multilineTextAlignment(.leading)
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(.primary.opacity(0.15), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(self.title))
        .accessibilityHint(Text(self.subtitle))
    }
}
