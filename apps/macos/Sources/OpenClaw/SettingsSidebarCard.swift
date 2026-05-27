import SwiftUI

extension View {
    func settingsSidebarCardLayout() -> some View {
        self
            .frame(minWidth: 220, idealWidth: 240, maxWidth: 280, maxHeight: .infinity, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(nsColor: .windowBackgroundColor)))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
