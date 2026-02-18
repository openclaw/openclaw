import SwiftUI

@main
struct OpenClawWatchApp: App {
    @State private var inboxStore = WatchInboxStore()
    @State private var receiver: WatchConnectivityReceiver?

    var body: some Scene {
        WindowGroup {
            WatchInboxView(store: self.inboxStore)
                .task {
                    if self.receiver == nil {
                        let receiver = WatchConnectivityReceiver(store: self.inboxStore)
                        receiver.activate()
                        self.receiver = receiver
                    }
                }
        }
    }
}
