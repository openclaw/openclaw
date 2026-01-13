import Foundation

enum GatewayAgentChannel: String, Codable, CaseIterable, Sendable {
    case last
    case whatsapp
    case telegram
    case discord
    case slack
    case signal
    case imessage
    case msteams
    case webchat

    init(raw: String?) {
        let normalized = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self = GatewayAgentChannel(rawValue: normalized) ?? .last
    }

    var isDeliverable: Bool { self != .webchat }

    func shouldDeliver(_ deliver: Bool) -> Bool { deliver && self.isDeliverable }
}
