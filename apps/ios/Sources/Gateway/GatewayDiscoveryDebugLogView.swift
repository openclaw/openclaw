import SwiftUI
import UIKit

struct GatewayDiscoveryDebugLogView: View {
    @Environment(GatewayConnectionController.self) private var gatewayController
    @AppStorage("gateway.discovery.debugLogs") private var debugLogsEnabled: Bool = false

    var body: some View {
        List {
            if !self.debugLogsEnabled {
                Text("Enable “Discovery Debug Logs” to start collecting events.")
                    .foregroundStyle(.secondary)
            }

            if self.gatewayController.discoveryDebugLog.isEmpty {
                Text("No log entries yet.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(self.gatewayController.discoveryDebugLog) { entry in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Self.formatTime(entry.ts))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(entry.message)
                            .font(.callout)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .navigationTitle("Discovery Logs")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Copy") {
                    UIPasteboard.general.string = self.formattedLog()
                }
                .disabled(self.gatewayController.discoveryDebugLog.isEmpty)
            }
        }
    }

    private func formattedLog() -> String {
        self.gatewayController.discoveryDebugLog
            .map { "\(Self.formatISO($0.ts)) \($0.message)" }
            .joined(separator: "\n")
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static func formatTime(_ date: Date) -> String {
        self.timeFormatter.string(from: date)
    }

    private static func formatISO(_ date: Date) -> String {
        self.isoFormatter.string(from: date)
    }
}
