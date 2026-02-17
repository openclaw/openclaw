import Foundation
#if canImport(UIKit)
import UIKit
#endif

public struct ShareGatewayRelayConfig: Codable, Sendable, Equatable {
    public let gatewayURLString: String
    public let token: String?
    public let password: String?
    public let sessionKey: String
    public let deliveryChannel: String?
    public let deliveryTo: String?

    public init(
        gatewayURLString: String,
        token: String?,
        password: String?,
        sessionKey: String,
        deliveryChannel: String? = nil,
        deliveryTo: String? = nil)
    {
        self.gatewayURLString = gatewayURLString
        self.token = token
        self.password = password
        self.sessionKey = sessionKey
        self.deliveryChannel = deliveryChannel
        self.deliveryTo = deliveryTo
    }
}

public enum ShareGatewayRelaySettings {
    private static let relayPasteboardName = "ai.openclaw.share.gatewayRelay"
    private static let relayPasteboardType = "ai.openclaw.share.gatewayRelay.v1"
    private static let eventPasteboardName = "ai.openclaw.share.events"
    private static let lastEventType = "ai.openclaw.share.gatewayRelay.event.v1"

    public static func loadConfig() -> ShareGatewayRelayConfig? {
        #if canImport(UIKit)
        guard let pasteboard = UIPasteboard(name: UIPasteboard.Name(self.relayPasteboardName), create: false) else {
            return nil
        }
        guard let data = pasteboard.data(forPasteboardType: self.relayPasteboardType) else { return nil }
        return try? JSONDecoder().decode(ShareGatewayRelayConfig.self, from: data)
        #else
        return nil
        #endif
    }

    public static func saveConfig(_ config: ShareGatewayRelayConfig) {
        #if canImport(UIKit)
        guard let data = try? JSONEncoder().encode(config) else { return }
        guard let pasteboard = UIPasteboard(name: UIPasteboard.Name(self.relayPasteboardName), create: true) else {
            return
        }
        pasteboard.setData(data, forPasteboardType: self.relayPasteboardType)
        #endif
    }

    public static func clearConfig() {
        #if canImport(UIKit)
        guard let pasteboard = UIPasteboard(name: UIPasteboard.Name(self.relayPasteboardName), create: false) else {
            return
        }
        pasteboard.items = []
        #endif
    }

    public static func saveLastEvent(_ message: String) {
        #if canImport(UIKit)
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let payload = "[\(timestamp)] \(message)"
        guard let data = payload.data(using: .utf8) else { return }
        guard let pasteboard = UIPasteboard(name: UIPasteboard.Name(self.eventPasteboardName), create: true) else {
            return
        }
        pasteboard.setData(data, forPasteboardType: self.lastEventType)
        #endif
    }

    public static func loadLastEvent() -> String? {
        #if canImport(UIKit)
        guard let pasteboard = UIPasteboard(name: UIPasteboard.Name(self.eventPasteboardName), create: false) else {
            return nil
        }
        guard let data = pasteboard.data(forPasteboardType: self.lastEventType) else { return nil }
        let value = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
        #else
        return nil
        #endif
    }
}
