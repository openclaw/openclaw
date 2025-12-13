import ClawdisNodeKit
import SwiftUI

struct ScreenTab: View {
    @EnvironmentObject private var appModel: NodeAppModel

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScreenWebView(controller: self.appModel.screen)
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

                if self.appModel.isBackgrounded {
                    Divider()
                    Text("Screen commands unavailable while backgrounded.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
            }
            .navigationTitle("Screen")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    // Navigation/mode selection is agent-driven; no local controls here.
}
