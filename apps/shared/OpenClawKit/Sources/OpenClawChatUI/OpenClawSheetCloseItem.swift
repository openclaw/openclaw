#if os(iOS)
import SwiftUI

extension View {
    /// Place inside the presentation: the native edge follows the sheet's scroll views and pushed pages.
    @ViewBuilder
    public func openClawSheetHeaderEdge() -> some View {
        if #available(iOS 26.0, *) {
            self.scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            self
        }
    }
}

/// The system close button, at the leading edge of a sheet's top bar. Only a sheet's root page carries it: a
/// pushed page has the system back button there, and the sheet still closes by dragging it down. The trailing
/// edge stays free for the sheet's one prominent action.
public struct OpenClawSheetCloseItem: ToolbarContent {
    let identifier: String?
    let action: () -> Void

    public init(identifier: String? = nil, action: @escaping () -> Void) {
        self.identifier = identifier
        self.action = action
    }

    public var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            // Every sheet's close was drawn in the primary color; some sheets tint everything with the accent.
            Group {
                if #available(iOS 26.0, *) {
                    Button(role: .close, action: self.action)
                } else {
                    Button(action: self.action) {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel(Text("Close"))
                }
            }
            .tint(.primary)
            .accessibilityIdentifier(self.identifier ?? "")
        }
    }
}
#endif
