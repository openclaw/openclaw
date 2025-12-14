import SwiftUI

@main
struct ClawdisApp: App {
    @State private var appModel: NodeAppModel
    @State private var bridgeController: BridgeConnectionController
    @Environment(\.scenePhase) private var scenePhase

    init() {
        BridgeSettingsStore.bootstrapPersistence()
        let appModel = NodeAppModel()
        _appModel = State(initialValue: appModel)
        _bridgeController = State(initialValue: BridgeConnectionController(appModel: appModel))
    }

    var body: some Scene {
        WindowGroup {
            RootCanvas()
                .environment(self.appModel)
                .environment(self.appModel.voiceWake)
                .environment(self.bridgeController)
                .onOpenURL { url in
                    Task { await self.appModel.handleDeepLink(url: url) }
                }
                .onChange(of: self.scenePhase) { _, newValue in
                    self.appModel.setScenePhase(newValue)
                    self.bridgeController.setScenePhase(newValue)
                }
        }
    }
}
