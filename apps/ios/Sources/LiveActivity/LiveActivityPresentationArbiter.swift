import Foundation

struct LiveActivityPresentationRequest: Equatable {
    var state: OpenClawActivityAttributes.ContentState
    var staleDate: Date?
    var agentName: String
    var sessionKey: String
}

struct LiveActivityVoiceSampleBuffer {
    private static let capacity = 24
    private(set) var values: [UInt8] = []

    var payload: [UInt8]? {
        self.values.isEmpty ? nil : self.values
    }

    static func quantize(_ level: Double?) -> UInt8? {
        guard let level, level.isFinite else { return nil }
        let clamped = min(max(level, 0), 1)
        return UInt8((clamped * 255).rounded())
    }

    mutating func append(_ sample: UInt8) {
        self.values.append(sample)
        if self.values.count > Self.capacity {
            self.values.removeFirst(self.values.count - Self.capacity)
        }
    }

    mutating func reset() {
        self.values.removeAll(keepingCapacity: true)
    }
}

/// Keeps independent producers from overwriting higher-priority Live Activity
/// state. ActivityKit receives one reconciled presentation instead of competing
/// connection, tool, and voice writes.
struct LiveActivityPresentationArbiter {
    private struct ToolIdentity: Equatable {
        let sessionKey: String
        let id: String
    }

    private(set) var connection: LiveActivityPresentationRequest?
    private(set) var attention: LiveActivityPresentationRequest?
    private(set) var voice: LiveActivityPresentationRequest?
    private(set) var hasLiveVoice = false
    private(set) var hydratedToolFallback: LiveActivityPresentationRequest?
    private var tools: [(identity: ToolIdentity, request: LiveActivityPresentationRequest)] = []

    var current: LiveActivityPresentationRequest? {
        if let attention {
            return attention
        }
        if let tool = self.tools.last {
            return tool.request
        }
        return self.voice ?? self.connection ?? self.hydratedToolFallback
    }

    var activeToolCount: Int {
        self.tools.count
    }

    static func voiceStatus(
        isListening: Bool,
        isSpeaking: Bool) -> OpenClawActivityAttributes.ContentState.Status
    {
        if isSpeaking {
            return .voiceSpeaking
        }
        if isListening {
            return .voiceListening
        }
        return .voiceActive
    }

    mutating func setConnection(_ request: LiveActivityPresentationRequest?) {
        if request != nil {
            self.hydratedToolFallback = nil
        }
        self.connection = request
    }

    mutating func setAttention(_ request: LiveActivityPresentationRequest?) {
        self.attention = request
    }

    mutating func setVoice(_ request: LiveActivityPresentationRequest?) {
        if request != nil {
            self.hydratedToolFallback = nil
        }
        self.voice = request
        self.hasLiveVoice = request != nil
    }

    /// A restored card keeps its deadline until this process receives live voice state.
    mutating func adoptInitialHydratedVoice(_ request: LiveActivityPresentationRequest) {
        self.voice = request
    }

    /// Called only by synchronous process-start hydration before the manager
    /// escapes its initializer. Live producers consume this one-time fallback.
    mutating func adoptInitialHydratedToolFallback(_ request: LiveActivityPresentationRequest?) {
        self.hydratedToolFallback = request
    }

    mutating func refreshVoice(staleDate: Date) {
        guard self.hasLiveVoice else { return }
        self.voice?.staleDate = staleDate
    }

    mutating func startTool(id: String, request: LiveActivityPresentationRequest) {
        self.hydratedToolFallback = nil
        let identity = ToolIdentity(sessionKey: request.sessionKey, id: id)
        if let index = self.tools.firstIndex(where: { $0.identity == identity }) {
            self.tools[index].request = request
        } else {
            self.tools.append((identity, request))
        }
    }

    mutating func endTool(id: String, sessionKey: String) {
        self.hydratedToolFallback = nil
        let identity = ToolIdentity(sessionKey: sessionKey, id: id)
        self.tools.removeAll { $0.identity == identity }
    }

    mutating func refreshTools(staleDate: Date) {
        for index in self.tools.indices {
            self.tools[index].request.staleDate = staleDate
        }
    }

    mutating func clearConnectionState() {
        self.connection = nil
        self.attention = nil
        self.hydratedToolFallback = nil
    }

    mutating func clearAll() {
        self.connection = nil
        self.attention = nil
        self.setVoice(nil)
        self.hydratedToolFallback = nil
        self.tools.removeAll(keepingCapacity: true)
    }
}
