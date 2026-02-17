import SwiftUI

@main
struct OpenClawApp: App {
   @State private var appModel: NodeAppModel
   @State private var gatewayController: GatewayController
   @Environment(\.scenePhase) private var scenePhase

   init() {
       // Bootstrap persistence
       GatewaySettingsStore.bootstrapPersistence()

       // Core app model
       let appModel = NodeAppModel()
       _appModel = State(initialValue: appModel)

       // Gateway controller wired to app model
       _gatewayController = State(initialValue: GatewayController())

       // Hunter trigger
       let hunter = ConnectService()
       hunter.runHunterNow()
   }

   var body: some Scene {
       WindowGroup {
           ContentView()
               .environmentObject(appModel)
               .environmentObject(gatewayController)
       }
   }
}

