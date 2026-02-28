import SwiftUI

@main
struct OpenClawWatchApp: App {
    @State private var inboxStore = WatchInboxStore()
    @State private var receiver: WatchConnectivityReceiver?

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                WatchHomeView(store: inboxStore) { action in
                    guard let receiver = self.receiver else { return }
                    let draft = self.inboxStore.makeReplyDraft(action: action)
                    self.inboxStore.markReplySending(actionLabel: action.label)
                    Task { @MainActor in
                        let result = await receiver.sendReply(draft)
                        self.inboxStore.markReplyResult(result, actionLabel: action.label)
                    }
                }
                .navigationTitle("OpenClaw")
            }
            .onOpenURL { _ in
                // Widget taps open openclaw://watch/inbox — the app already shows the
                // inbox as the root view, so no navigation is needed.
            }
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
