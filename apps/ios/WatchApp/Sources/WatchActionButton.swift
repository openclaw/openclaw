import SwiftUI

struct WatchActionButton: View {
    let label: String
    var role: ButtonRole?
    var isLoading: Bool = false
    var isDisabled: Bool = false
    let action: () -> Void

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
    }
}
