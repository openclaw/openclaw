import SwiftUI

/// Stop replaces Send under the finger, so a double tap must not stop the message it just sent.
/// Stop stays dimmed and inert for a moment after it appears.
struct ChatStopGuard: ViewModifier {
    @State private var isArmed = false

    func body(content: Content) -> some View {
        content
            .disabled(!self.isArmed)
            .opacity(self.isArmed ? 1 : 0.35)
            .task {
                do {
                    try await Task.sleep(for: .milliseconds(700))
                } catch {
                    return
                }
                self.isArmed = !Task.isCancelled
            }
            .onDisappear { self.isArmed = false }
    }
}
