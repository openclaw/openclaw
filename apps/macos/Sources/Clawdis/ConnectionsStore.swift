import ClawdisProtocol
import Foundation
import Observation

struct ProvidersStatusSnapshot: Codable {
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

    let ts: Double
    let whatsapp: WhatsAppStatus
    let telegram: TelegramStatus
    let discord: DiscordStatus?
    let signal: SignalStatus?
    let imessage: IMessageStatus?
}

struct ConfigSnapshot: Codable {
    struct Issue: Codable {
        let path: String
        let message: String
    }

    let path: String?
    let exists: Bool?
    let raw: String?
    let parsed: AnyCodable?
    let valid: Bool?
    let config: [String: AnyCodable]?
    let issues: [Issue]?
}

@MainActor
@Observable
final class ConnectionsStore {
    static let shared = ConnectionsStore()

    var snapshot: ProvidersStatusSnapshot?
    var lastError: String?
    var lastSuccess: Date?
    var isRefreshing = false

    var whatsappLoginMessage: String?
    var whatsappLoginQrDataUrl: String?
    var whatsappLoginConnected: Bool?
    var whatsappBusy = false

    var telegramToken: String = ""
    var telegramRequireMention = true
    var telegramAllowFrom: String = ""
    var telegramProxy: String = ""
    var telegramWebhookUrl: String = ""
    var telegramWebhookSecret: String = ""
    var telegramWebhookPath: String = ""
    var telegramBusy = false
    var discordToken: String = ""
    var discordRequireMention = true
    var discordAllowFrom: String = ""
    var discordGuildAllowFrom: String = ""
    var discordGuildUsersAllowFrom: String = ""
    var discordMediaMaxMb: String = ""
    var signalEnabled = true
    var signalAccount: String = ""
    var signalHttpUrl: String = ""
    var signalHttpHost: String = ""
    var signalHttpPort: String = ""
    var signalCliPath: String = ""
    var signalAutoStart = true
    var signalReceiveMode: String = ""
    var signalIgnoreAttachments = false
    var signalIgnoreStories = false
    var signalSendReadReceipts = false
    var signalAllowFrom: String = ""
    var signalMediaMaxMb: String = ""
    var imessageEnabled = true
    var imessageCliPath: String = ""
    var imessageDbPath: String = ""
    var imessageService: String = "auto"
    var imessageRegion: String = ""
    var imessageAllowFrom: String = ""
    var imessageIncludeAttachments = false
    var imessageMediaMaxMb: String = ""
    var configStatus: String?
    var isSavingConfig = false

    private let interval: TimeInterval = 45
    private let isPreview: Bool
    private var pollTask: Task<Void, Never>?
    private var configRoot: [String: Any] = [:]
    private var configLoaded = false

    init(isPreview: Bool = ProcessInfo.processInfo.isPreview) {
        self.isPreview = isPreview
    }

    func start() {
        guard !self.isPreview else { return }
        guard self.pollTask == nil else { return }
        self.pollTask = Task.detached { [weak self] in
            guard let self else { return }
            await self.refresh(probe: true)
            await self.loadConfig()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(self.interval * 1_000_000_000))
                await self.refresh(probe: false)
            }
        }
    }

    func stop() {
        self.pollTask?.cancel()
        self.pollTask = nil
    }

    func refresh(probe: Bool) async {
        guard !self.isRefreshing else { return }
        self.isRefreshing = true
        defer { self.isRefreshing = false }

        do {
            let params: [String: AnyCodable] = [
                "probe": AnyCodable(probe),
                "timeoutMs": AnyCodable(8000),
            ]
            let snap: ProvidersStatusSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .providersStatus,
                params: params,
                timeoutMs: 12000)
            self.snapshot = snap
            self.lastSuccess = Date()
            self.lastError = nil
        } catch {
            self.lastError = error.localizedDescription
        }
    }

    func startWhatsAppLogin(force: Bool, autoWait: Bool = true) async {
        guard !self.whatsappBusy else { return }
        self.whatsappBusy = true
        defer { self.whatsappBusy = false }
        var shouldAutoWait = false
        do {
            let params: [String: AnyCodable] = [
                "force": AnyCodable(force),
                "timeoutMs": AnyCodable(30000),
            ]
            let result: WhatsAppLoginStartResult = try await GatewayConnection.shared.requestDecoded(
                method: .webLoginStart,
                params: params,
                timeoutMs: 35000)
            self.whatsappLoginMessage = result.message
            self.whatsappLoginQrDataUrl = result.qrDataUrl
            self.whatsappLoginConnected = nil
            shouldAutoWait = autoWait && result.qrDataUrl != nil
        } catch {
            self.whatsappLoginMessage = error.localizedDescription
            self.whatsappLoginQrDataUrl = nil
            self.whatsappLoginConnected = nil
        }
        await self.refresh(probe: true)
        if shouldAutoWait {
            Task { await self.waitWhatsAppLogin() }
        }
    }

    func waitWhatsAppLogin(timeoutMs: Int = 120_000) async {
        guard !self.whatsappBusy else { return }
        self.whatsappBusy = true
        defer { self.whatsappBusy = false }
        do {
            let params: [String: AnyCodable] = [
                "timeoutMs": AnyCodable(timeoutMs),
            ]
            let result: WhatsAppLoginWaitResult = try await GatewayConnection.shared.requestDecoded(
                method: .webLoginWait,
                params: params,
                timeoutMs: Double(timeoutMs) + 5000)
            self.whatsappLoginMessage = result.message
            self.whatsappLoginConnected = result.connected
            if result.connected {
                self.whatsappLoginQrDataUrl = nil
            }
        } catch {
            self.whatsappLoginMessage = error.localizedDescription
        }
        await self.refresh(probe: true)
    }

    func logoutWhatsApp() async {
        guard !self.whatsappBusy else { return }
        self.whatsappBusy = true
        defer { self.whatsappBusy = false }
        do {
            let result: WhatsAppLogoutResult = try await GatewayConnection.shared.requestDecoded(
                method: .webLogout,
                params: nil,
                timeoutMs: 15000)
            self.whatsappLoginMessage = result.cleared
                ? "Logged out and cleared credentials."
                : "No WhatsApp session found."
            self.whatsappLoginQrDataUrl = nil
        } catch {
            self.whatsappLoginMessage = error.localizedDescription
        }
        await self.refresh(probe: true)
    }

    func logoutTelegram() async {
        guard !self.telegramBusy else { return }
        self.telegramBusy = true
        defer { self.telegramBusy = false }
        do {
            let result: TelegramLogoutResult = try await GatewayConnection.shared.requestDecoded(
                method: .telegramLogout,
                params: nil,
                timeoutMs: 15000)
            if result.envToken == true {
                self.configStatus = "Telegram token still set via env; config cleared."
            } else {
                self.configStatus = result.cleared
                    ? "Telegram token cleared."
                    : "No Telegram token configured."
            }
            await self.loadConfig()
        } catch {
            self.configStatus = error.localizedDescription
        }
        await self.refresh(probe: true)
    }

    func loadConfig() async {
        do {
            let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .configGet,
                params: nil,
                timeoutMs: 10000)
            self.configStatus = snap.valid == false
                ? "Config invalid; fix it in ~/.clawdis/clawdis.json."
                : nil
            self.configRoot = snap.config?.mapValues { $0.foundationValue } ?? [:]
            self.configLoaded = true

            let ui = snap.config?["ui"]?.dictionaryValue
            let rawSeam = ui?["seamColor"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            AppStateStore.shared.seamColorHex = rawSeam.isEmpty ? nil : rawSeam

            let telegram = snap.config?["telegram"]?.dictionaryValue
            self.telegramToken = telegram?["botToken"]?.stringValue ?? ""
            self.telegramRequireMention = telegram?["requireMention"]?.boolValue ?? true
            if let allow = telegram?["allowFrom"]?.arrayValue {
                let strings = allow.compactMap { entry -> String? in
                    if let str = entry.stringValue { return str }
                    if let intVal = entry.intValue { return String(intVal) }
                    if let doubleVal = entry.doubleValue { return String(Int(doubleVal)) }
                    return nil
                }
                self.telegramAllowFrom = strings.joined(separator: ", ")
            } else {
                self.telegramAllowFrom = ""
            }
            self.telegramProxy = telegram?["proxy"]?.stringValue ?? ""
            self.telegramWebhookUrl = telegram?["webhookUrl"]?.stringValue ?? ""
            self.telegramWebhookSecret = telegram?["webhookSecret"]?.stringValue ?? ""
            self.telegramWebhookPath = telegram?["webhookPath"]?.stringValue ?? ""

            let discord = snap.config?["discord"]?.dictionaryValue
            self.discordToken = discord?["token"]?.stringValue ?? ""
            self.discordRequireMention = discord?["requireMention"]?.boolValue ?? true
            if let allow = discord?["allowFrom"]?.arrayValue {
                let strings = allow.compactMap { entry -> String? in
                    if let str = entry.stringValue { return str }
                    if let intVal = entry.intValue { return String(intVal) }
                    if let doubleVal = entry.doubleValue { return String(Int(doubleVal)) }
                    return nil
                }
                self.discordAllowFrom = strings.joined(separator: ", ")
            } else {
                self.discordAllowFrom = ""
            }
            if let guildAllow = discord?["guildAllowFrom"]?.dictionaryValue {
                if let guilds = guildAllow["guilds"]?.arrayValue {
                    let strings = guilds.compactMap { entry -> String? in
                        if let str = entry.stringValue { return str }
                        if let intVal = entry.intValue { return String(intVal) }
                        if let doubleVal = entry.doubleValue { return String(Int(doubleVal)) }
                        return nil
                    }
                    self.discordGuildAllowFrom = strings.joined(separator: ", ")
                } else {
                    self.discordGuildAllowFrom = ""
                }
                if let users = guildAllow["users"]?.arrayValue {
                    let strings = users.compactMap { entry -> String? in
                        if let str = entry.stringValue { return str }
                        if let intVal = entry.intValue { return String(intVal) }
                        if let doubleVal = entry.doubleValue { return String(Int(doubleVal)) }
                        return nil
                    }
                    self.discordGuildUsersAllowFrom = strings.joined(separator: ", ")
                } else {
                    self.discordGuildUsersAllowFrom = ""
                }
            } else {
                self.discordGuildAllowFrom = ""
                self.discordGuildUsersAllowFrom = ""
            }
            if let media = discord?["mediaMaxMb"]?.doubleValue ?? discord?["mediaMaxMb"]?.intValue.map(Double.init) {
                self.discordMediaMaxMb = String(Int(media))
            } else {
                self.discordMediaMaxMb = ""
            }

            let signal = snap.config?["signal"]?.dictionaryValue
            self.signalEnabled = signal?["enabled"]?.boolValue ?? true
            self.signalAccount = signal?["account"]?.stringValue ?? ""
            self.signalHttpUrl = signal?["httpUrl"]?.stringValue ?? ""
            self.signalHttpHost = signal?["httpHost"]?.stringValue ?? ""
            if let port = signal?["httpPort"]?.doubleValue ?? signal?["httpPort"]?.intValue.map(Double.init) {
                self.signalHttpPort = String(Int(port))
            } else {
                self.signalHttpPort = ""
            }
            self.signalCliPath = signal?["cliPath"]?.stringValue ?? ""
            self.signalAutoStart = signal?["autoStart"]?.boolValue ?? true
            self.signalReceiveMode = signal?["receiveMode"]?.stringValue ?? ""
            self.signalIgnoreAttachments = signal?["ignoreAttachments"]?.boolValue ?? false
            self.signalIgnoreStories = signal?["ignoreStories"]?.boolValue ?? false
            self.signalSendReadReceipts = signal?["sendReadReceipts"]?.boolValue ?? false
            if let allow = signal?["allowFrom"]?.arrayValue {
                let strings = allow.compactMap { entry -> String? in
                    if let str = entry.stringValue { return str }
                    if let intVal = entry.intValue { return String(intVal) }
                    if let doubleVal = entry.doubleValue { return String(Int(doubleVal)) }
                    return nil
                }
                self.signalAllowFrom = strings.joined(separator: ", ")
            } else {
                self.signalAllowFrom = ""
            }
            if let media = signal?["mediaMaxMb"]?.doubleValue ?? signal?["mediaMaxMb"]?.intValue.map(Double.init) {
                self.signalMediaMaxMb = String(Int(media))
            } else {
                self.signalMediaMaxMb = ""
            }

            let imessage = snap.config?["imessage"]?.dictionaryValue
            self.imessageEnabled = imessage?["enabled"]?.boolValue ?? true
            self.imessageCliPath = imessage?["cliPath"]?.stringValue ?? ""
            self.imessageDbPath = imessage?["dbPath"]?.stringValue ?? ""
            self.imessageService = imessage?["service"]?.stringValue ?? "auto"
            self.imessageRegion = imessage?["region"]?.stringValue ?? ""
            if let allow = imessage?["allowFrom"]?.arrayValue {
                let strings = allow.compactMap { entry -> String? in
                    if let str = entry.stringValue { return str }
                    if let intVal = entry.intValue { return String(intVal) }
                    if let doubleVal = entry.doubleValue { return String(Int(doubleVal)) }
                    return nil
                }
                self.imessageAllowFrom = strings.joined(separator: ", ")
            } else {
                self.imessageAllowFrom = ""
            }
            self.imessageIncludeAttachments = imessage?["includeAttachments"]?.boolValue ?? false
            if let media = imessage?["mediaMaxMb"]?.doubleValue ?? imessage?["mediaMaxMb"]?.intValue.map(Double.init) {
                self.imessageMediaMaxMb = String(Int(media))
            } else {
                self.imessageMediaMaxMb = ""
            }
        } catch {
            self.configStatus = error.localizedDescription
        }
    }

    func saveTelegramConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        var telegram: [String: Any] = (self.configRoot["telegram"] as? [String: Any]) ?? [:]
        let token = self.telegramToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if token.isEmpty {
            telegram.removeValue(forKey: "botToken")
        } else {
            telegram["botToken"] = token
        }

        if self.telegramRequireMention {
            telegram["requireMention"] = true
        } else {
            telegram["requireMention"] = false
        }

        let allow = self.telegramAllowFrom
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if allow.isEmpty {
            telegram.removeValue(forKey: "allowFrom")
        } else {
            telegram["allowFrom"] = allow
        }

        let proxy = self.telegramProxy.trimmingCharacters(in: .whitespacesAndNewlines)
        if proxy.isEmpty {
            telegram.removeValue(forKey: "proxy")
        } else {
            telegram["proxy"] = proxy
        }

        let webhookUrl = self.telegramWebhookUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if webhookUrl.isEmpty {
            telegram.removeValue(forKey: "webhookUrl")
        } else {
            telegram["webhookUrl"] = webhookUrl
        }

        let webhookSecret = self.telegramWebhookSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        if webhookSecret.isEmpty {
            telegram.removeValue(forKey: "webhookSecret")
        } else {
            telegram["webhookSecret"] = webhookSecret
        }

        let webhookPath = self.telegramWebhookPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if webhookPath.isEmpty {
            telegram.removeValue(forKey: "webhookPath")
        } else {
            telegram["webhookPath"] = webhookPath
        }

        if telegram.isEmpty {
            self.configRoot.removeValue(forKey: "telegram")
        } else {
            self.configRoot["telegram"] = telegram
        }

        do {
            let data = try JSONSerialization.data(
                withJSONObject: self.configRoot,
                options: [.prettyPrinted, .sortedKeys])
            guard let raw = String(data: data, encoding: .utf8) else {
                self.configStatus = "Failed to encode config."
                return
            }
            let params: [String: AnyCodable] = ["raw": AnyCodable(raw)]
            _ = try await GatewayConnection.shared.requestRaw(
                method: .configSet,
                params: params,
                timeoutMs: 10000)
            self.configStatus = "Saved to ~/.clawdis/clawdis.json."
            await self.refresh(probe: true)
        } catch {
            self.configStatus = error.localizedDescription
        }
    }

    func saveDiscordConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        var discord: [String: Any] = (self.configRoot["discord"] as? [String: Any]) ?? [:]
        let token = self.discordToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if token.isEmpty {
            discord.removeValue(forKey: "token")
        } else {
            discord["token"] = token
        }

        discord["requireMention"] = self.discordRequireMention

        let allow = self.discordAllowFrom
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if allow.isEmpty {
            discord.removeValue(forKey: "allowFrom")
        } else {
            discord["allowFrom"] = allow
        }

        var guildAllow: [String: Any] = (discord["guildAllowFrom"] as? [String: Any]) ?? [:]
        let guilds = self.discordGuildAllowFrom
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if guilds.isEmpty {
            guildAllow.removeValue(forKey: "guilds")
        } else {
            guildAllow["guilds"] = guilds
        }

        let users = self.discordGuildUsersAllowFrom
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if users.isEmpty {
            guildAllow.removeValue(forKey: "users")
        } else {
            guildAllow["users"] = users
        }

        if guildAllow.isEmpty {
            discord.removeValue(forKey: "guildAllowFrom")
        } else {
            discord["guildAllowFrom"] = guildAllow
        }

        let media = self.discordMediaMaxMb.trimmingCharacters(in: .whitespacesAndNewlines)
        if media.isEmpty {
            discord.removeValue(forKey: "mediaMaxMb")
        } else if let value = Double(media) {
            discord["mediaMaxMb"] = value
        }

        if discord.isEmpty {
            self.configRoot.removeValue(forKey: "discord")
        } else {
            self.configRoot["discord"] = discord
        }

        do {
            let data = try JSONSerialization.data(
                withJSONObject: self.configRoot,
                options: [.prettyPrinted, .sortedKeys])
            guard let raw = String(data: data, encoding: .utf8) else {
                self.configStatus = "Failed to encode config."
                return
            }
            let params: [String: AnyCodable] = ["raw": AnyCodable(raw)]
            _ = try await GatewayConnection.shared.requestRaw(
                method: .configSet,
                params: params,
                timeoutMs: 10000)
            self.configStatus = "Saved to ~/.clawdis/clawdis.json."
            await self.refresh(probe: true)
        } catch {
            self.configStatus = error.localizedDescription
        }
    }

    func saveSignalConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        var signal: [String: Any] = (self.configRoot["signal"] as? [String: Any]) ?? [:]
        if self.signalEnabled {
            signal.removeValue(forKey: "enabled")
        } else {
            signal["enabled"] = false
        }

        let account = self.signalAccount.trimmingCharacters(in: .whitespacesAndNewlines)
        if account.isEmpty {
            signal.removeValue(forKey: "account")
        } else {
            signal["account"] = account
        }

        let httpUrl = self.signalHttpUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if httpUrl.isEmpty {
            signal.removeValue(forKey: "httpUrl")
        } else {
            signal["httpUrl"] = httpUrl
        }

        let httpHost = self.signalHttpHost.trimmingCharacters(in: .whitespacesAndNewlines)
        if httpHost.isEmpty {
            signal.removeValue(forKey: "httpHost")
        } else {
            signal["httpHost"] = httpHost
        }

        let httpPort = self.signalHttpPort.trimmingCharacters(in: .whitespacesAndNewlines)
        if httpPort.isEmpty {
            signal.removeValue(forKey: "httpPort")
        } else if let value = Double(httpPort) {
            signal["httpPort"] = value
        }

        let cliPath = self.signalCliPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if cliPath.isEmpty {
            signal.removeValue(forKey: "cliPath")
        } else {
            signal["cliPath"] = cliPath
        }

        if self.signalAutoStart {
            signal.removeValue(forKey: "autoStart")
        } else {
            signal["autoStart"] = false
        }

        let receiveMode = self.signalReceiveMode.trimmingCharacters(in: .whitespacesAndNewlines)
        if receiveMode.isEmpty {
            signal.removeValue(forKey: "receiveMode")
        } else {
            signal["receiveMode"] = receiveMode
        }

        if self.signalIgnoreAttachments {
            signal["ignoreAttachments"] = true
        } else {
            signal.removeValue(forKey: "ignoreAttachments")
        }
        if self.signalIgnoreStories {
            signal["ignoreStories"] = true
        } else {
            signal.removeValue(forKey: "ignoreStories")
        }
        if self.signalSendReadReceipts {
            signal["sendReadReceipts"] = true
        } else {
            signal.removeValue(forKey: "sendReadReceipts")
        }

        let allow = self.signalAllowFrom
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if allow.isEmpty {
            signal.removeValue(forKey: "allowFrom")
        } else {
            signal["allowFrom"] = allow
        }

        let media = self.signalMediaMaxMb.trimmingCharacters(in: .whitespacesAndNewlines)
        if media.isEmpty {
            signal.removeValue(forKey: "mediaMaxMb")
        } else if let value = Double(media) {
            signal["mediaMaxMb"] = value
        }

        if signal.isEmpty {
            self.configRoot.removeValue(forKey: "signal")
        } else {
            self.configRoot["signal"] = signal
        }

        do {
            let data = try JSONSerialization.data(
                withJSONObject: self.configRoot,
                options: [.prettyPrinted, .sortedKeys])
            guard let raw = String(data: data, encoding: .utf8) else {
                self.configStatus = "Failed to encode config."
                return
            }
            let params: [String: AnyCodable] = ["raw": AnyCodable(raw)]
            _ = try await GatewayConnection.shared.requestRaw(
                method: .configSet,
                params: params,
                timeoutMs: 10000)
            self.configStatus = "Saved to ~/.clawdis/clawdis.json."
            await self.refresh(probe: true)
        } catch {
            self.configStatus = error.localizedDescription
        }
    }

    func saveIMessageConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        var imessage: [String: Any] = (self.configRoot["imessage"] as? [String: Any]) ?? [:]
        if self.imessageEnabled {
            imessage.removeValue(forKey: "enabled")
        } else {
            imessage["enabled"] = false
        }

        let cliPath = self.imessageCliPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if cliPath.isEmpty {
            imessage.removeValue(forKey: "cliPath")
        } else {
            imessage["cliPath"] = cliPath
        }

        let dbPath = self.imessageDbPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if dbPath.isEmpty {
            imessage.removeValue(forKey: "dbPath")
        } else {
            imessage["dbPath"] = dbPath
        }

        let service = self.imessageService.trimmingCharacters(in: .whitespacesAndNewlines)
        if service.isEmpty || service == "auto" {
            imessage.removeValue(forKey: "service")
        } else {
            imessage["service"] = service
        }

        let region = self.imessageRegion.trimmingCharacters(in: .whitespacesAndNewlines)
        if region.isEmpty {
            imessage.removeValue(forKey: "region")
        } else {
            imessage["region"] = region
        }

        let allow = self.imessageAllowFrom
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if allow.isEmpty {
            imessage.removeValue(forKey: "allowFrom")
        } else {
            imessage["allowFrom"] = allow
        }

        if self.imessageIncludeAttachments {
            imessage["includeAttachments"] = true
        } else {
            imessage.removeValue(forKey: "includeAttachments")
        }

        let media = self.imessageMediaMaxMb.trimmingCharacters(in: .whitespacesAndNewlines)
        if media.isEmpty {
            imessage.removeValue(forKey: "mediaMaxMb")
        } else if let value = Double(media) {
            imessage["mediaMaxMb"] = value
        }

        if imessage.isEmpty {
            self.configRoot.removeValue(forKey: "imessage")
        } else {
            self.configRoot["imessage"] = imessage
        }

        do {
            let data = try JSONSerialization.data(
                withJSONObject: self.configRoot,
                options: [.prettyPrinted, .sortedKeys])
            guard let raw = String(data: data, encoding: .utf8) else {
                self.configStatus = "Failed to encode config."
                return
            }
            let params: [String: AnyCodable] = ["raw": AnyCodable(raw)]
            _ = try await GatewayConnection.shared.requestRaw(
                method: .configSet,
                params: params,
                timeoutMs: 10000)
            self.configStatus = "Saved to ~/.clawdis/clawdis.json."
            await self.refresh(probe: true)
        } catch {
            self.configStatus = error.localizedDescription
        }
    }
}

private struct WhatsAppLoginStartResult: Codable {
    let qrDataUrl: String?
    let message: String
}

private struct WhatsAppLoginWaitResult: Codable {
    let connected: Bool
    let message: String
}

private struct WhatsAppLogoutResult: Codable {
    let cleared: Bool
}

private struct TelegramLogoutResult: Codable {
    let cleared: Bool
    let envToken: Bool?
}
