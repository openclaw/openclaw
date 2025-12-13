import SwiftUI

@main
struct ClawdisApp: App {
    @StateObject private var appModel = NodeAppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootCanvas()
                .environmentObject(self.appModel)
                .environmentObject(self.appModel.voiceWake)
                .onOpenURL { url in
                    Task { await self.appModel.handleDeepLink(url: url) }
                }
                .onChange(of: self.scenePhase) { _, newValue in
                    self.appModel.setScenePhase(newValue)
                }
        }
    }
}
