import AppIntents
import SwiftUI
import WidgetKit

// MARK: - Connection state shared via UserDefaults

/// Lightweight provider that reads connection state written by the main app
/// via `UserDefaults`. ControlWidgets run out-of-process, so we bridge state
/// through a shared defaults key.
enum ConnectionStatusProvider {
    private static let key = "watch.control.isConnected"

    static var isConnected: Bool {
        WatchAppGroup.defaults.bool(forKey: key)
    }

    /// Called by the main app when reachability changes.
    static func write(isConnected: Bool) {
        WatchAppGroup.defaults.set(isConnected, forKey: key)
        ControlCenter.shared.reloadControls(
            ofKind: ConnectionStatusControl.kind)
    }
}

// MARK: - Quick Reply Control

/// Button control that opens the app to reply to the latest notification.
struct QuickReplyControl: ControlWidget {
    static let kind = "ai.openclaw.watch.quick-reply"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: QuickReplyIntent()) {
                Label("Quick Reply", systemImage: "arrowshape.turn.up.left.fill")
            }
        }
        .displayName("Quick Reply")
        .description("Send a quick reply to the latest notification")
    }
}

// MARK: - Connection Status Control

/// Status toggle showing the gateway connection state. Tapping opens the app.
struct ConnectionStatusControl: ControlWidget {
    static let kind = "ai.openclaw.watch.connection-status"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            let connected = ConnectionStatusProvider.isConnected
            ControlWidgetToggle(
                isOn: connected,
                action: ConnectionStatusToggleIntent()
            ) {
                Label {
                    Text(connected ? "Connected" : "Disconnected")
                } icon: {
                    Image(
                        systemName: connected
                            ? "antenna.radiowaves.left.and.right"
                            : "antenna.radiowaves.left.and.right.slash")
                }
            }
        }
        .displayName("Connection")
        .description("OpenClaw gateway connection status")
    }
}
