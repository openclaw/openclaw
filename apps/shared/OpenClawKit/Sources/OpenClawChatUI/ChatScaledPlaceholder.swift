import SwiftUI

struct ChatScaledPlaceholder: View {
    let text: String
    @Environment(\.openClawChatTextScale) private var textScale

    var body: some View {
        Text(self.text)
            .font(OpenClawChatTypography.body(
                size: 17, weight: .regular, relativeTo: .body, textScale: self.textScale))
    }
}
