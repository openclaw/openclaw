import ClawdbotProtocol
import Foundation
import Observation

struct ChannelsStatusSnapshot: Codable {
    struct WhatsAppSelf: Codable {
        let e164: String?
        let jid: String?
    }

    struct WhatsAppDisconnect: Codable {
        let at: Double
        let status: Int?
        let error: String?
        let loggedOut: Bool?
    }

    struct WhatsAppStatus: Codable {
        let configured: Bool
        let linked: Bool
        let authAgeMs: Double?
        let `self`: WhatsAppSelf?
        let running: Bool
        let connected: Bool
        let lastConnectedAt: Double?
        let lastDisconnect: WhatsAppDisconnect?
        let reconnectAttempts: Int
        let lastMessageAt: Double?
        let lastEventAt: Double?
        let lastError: String?
    }

    struct TelegramBot: Codable {
        let id: Int?
        let username: String?
    }

    struct TelegramWebhook: Codable {
        let url: String?
        let hasCustomCert: Bool?
    }

    struct TelegramProbe: Codable {
        let ok: Bool
        let status: Int?
        let error: String?
        let elapsedMs: Double?
        let bot: TelegramBot?
        let webhook: TelegramWebhook?
    }

    struct TelegramStatus: Codable {
        let configured: Bool
        let tokenSource: String?
        let running: Bool
        let mode: String?
        let lastStartAt: Double?
        let lastStopAt: Double?
        let lastError: String?
        let probe: TelegramProbe?
        let lastProbeAt: Double?
    }

    struct DiscordBot: Codable {
        let id: String?
        let username: String?
    }

    struct DiscordProbe: Codable {
        let ok: Bool
        let status: Int?
        let error: String?
        let elapsedMs: Double?
        let bot: DiscordBot?
    }

    struct DiscordStatus: Codable {
        let configured: Bool
        let tokenSource: String?
        let running: Bool
        let lastStartAt: Double?
        let lastStopAt: Double?
        let lastError: String?
        let probe: DiscordProbe?
        let lastProbeAt: Double?
    }

    struct SignalProbe: Codable {
        let ok: Bool
        let status: Int?
        let error: String?
        let elapsedMs: Double?
        let version: String?
    }

    struct SignalStatus: Codable {
        let configured: Bool
        let baseUrl: String
        let running: Bool
        let lastStartAt: Double?
        let lastStopAt: Double?
        let lastError: String?
        let probe: SignalProbe?
        let lastProbeAt: Double?
    }

    struct IMessageProbe: Codable {
        let ok: Bool
        let error: String?
    }

    struct IMessageStatus: Codable {
        let configured: Bool
        let running: Bool
        let lastStartAt: Double?
        let lastStopAt: Double?
        let lastError: String?
        let cliPath: String?
        let dbPath: String?
        let probe: IMessageProbe?
        let lastProbeAt: Double?
    }

    struct ChannelAccountSnapshot: Codable {
        let accountId: String
        let name: String?
        let enabled: Bool?
        let configured: Bool?
        let linked: Bool?
        let running: Bool?
        let connected: Bool?
        let reconnectAttempts: Int?
        let lastConnectedAt: Double?
        let lastError: String?
        let lastStartAt: Double?
        let lastStopAt: Double?
        let lastInboundAt: Double?
        let lastOutboundAt: Double?
        let lastProbeAt: Double?
        let mode: String?
        let dmPolicy: String?
        let allowFrom: [String]?
        let tokenSource: String?
        let botTokenSource: String?
        let appTokenSource: String?
        let baseUrl: String?
        let allowUnmentionedGroups: Bool?
        let cliPath: String?
        let dbPath: String?
        let port: Int?
        let probe: AnyCodable?
        let audit: AnyCodable?
        let application: AnyCodable?
    }

    let ts: Double
    let channelOrder: [String]
    let channelLabels: [String: String]
    let channels: [String: AnyCodable]
    let channelAccounts: [String: [ChannelAccountSnapshot]]
    let channelDefaultAccountId: [String: String]

    func decodeChannel<T: Decodable>(_ id: String, as type: T.Type) -> T? {
        guard let value = self.channels[id] else { return nil }
        do {
            let data = try JSONEncoder().encode(value)
            return try JSONDecoder().decode(type, from: data)
        } catch {
            return nil
        }
    }
}

struct ConfigSnapshot: Codable {
    struct Issue: Codable {
        let path: String
        let message: String
    }

    let path: String?
    let exists: Bool?
    let raw: String?
    let hash: String?
    let parsed: AnyCodable?
    let valid: Bool?
    let config: [String: AnyCodable]?
    let issues: [Issue]?
}

@MainActor
@Observable
final class ChannelsStore {
    static let shared = ChannelsStore()

    var snapshot: ChannelsStatusSnapshot?
    var lastError: String?
    var lastSuccess: Date?
    var isRefreshing = false

    var whatsappLoginMessage: String?
    var whatsappLoginQrDataUrl: String?
    var whatsappLoginConnected: Bool?
    var whatsappBusy = false
    var telegramBusy = false

    var configStatus: String?
    var isSavingConfig = false
    var configSchemaLoading = false
    var configSchema: ConfigSchemaNode?
    var configUiHints: [String: ConfigUiHint] = [:]
    var configDraft: [String: Any] = [:]
    var configDirty = false

    let interval: TimeInterval = 45
    let isPreview: Bool
    var pollTask: Task<Void, Never>?
    var configRoot: [String: Any] = [:]
    var configLoaded = false

    init(isPreview: Bool = ProcessInfo.processInfo.isPreview) {
        self.isPreview = isPreview
    }
}
