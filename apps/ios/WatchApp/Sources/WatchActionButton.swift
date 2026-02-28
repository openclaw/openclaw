import SwiftUI

struct WatchActionButton: View {
    let label: String
    var role: ButtonRole?
    var isLoading: Bool = false
    var isDisabled: Bool = false
    let action: () -> Void

    private var accessibilityStateValue: String? {
        if isLoading { return "Sending" }
        if isDisabled { return "Disabled" }
        return nil
    }

    var body: some View {
        Button(role: role, action: action) {
            Group {
                if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else {
                    Text(label)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .buttonStyle(.glass)
        .disabled(isDisabled || isLoading)
        .accessibilityHint(role == .destructive ? "Destructive action" : "Sends a reply")
        .accessibilityValue(accessibilityStateValue ?? "")
    }
}
