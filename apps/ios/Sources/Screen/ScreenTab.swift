import ClawdisKit
import SwiftUI

struct ScreenTab: View {
    @EnvironmentObject private var appModel: NodeAppModel

    var body: some View {
        ZStack(alignment: .top) {
            ScreenWebView(controller: self.appModel.screen)
                .ignoresSafeArea()
                .overlay(alignment: .top) {
                    if let errorText = self.appModel.screen.errorText {
                        Text(errorText)
                            .font(.footnote)
                            .padding(10)
                            .background(.thinMaterial)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .padding()
                    }
                }
        }
    }

    // Navigation/mode selection is agent-driven; no local controls here.
}
