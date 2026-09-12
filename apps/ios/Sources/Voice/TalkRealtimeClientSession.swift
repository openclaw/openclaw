import Foundation

struct TalkRealtimeClientCreateParams: Encodable {
    var sessionKey: String?
    var voiceSessionId: String?
    var mode = "realtime"
    var provider: String?
    var transport = "webrtc"
    var brain = "agent-consult"
    var model: String?
    var voice: String?
    var capabilities: [String]
}

struct TalkRealtimeClientSession: Decodable {
    let provider: String
    let transport: String
    let voiceSessionId: String?
    let clientSecret: String
    let offerUrl: String?
    let offerHeaders: [String: String]?
    let model: String?
    let voice: String?
    let expiresAt: Double?
    let clientControl: TalkRealtimeClientControl?

    var isWebRTC: Bool {
        self.transport.caseInsensitiveCompare("webrtc") == .orderedSame
    }
}

struct TalkRealtimeClientControl: Decodable {
    let owner: String
}

enum TalkRealtimeTranscriptRole: String, Encodable {
    case user
    case assistant
}

struct TalkRealtimeTranscriptParams: Encodable {
    let sessionKey: String
    let voiceSessionId: String
    let entryId: String
    let role: TalkRealtimeTranscriptRole
    let text: String
    let timestamp: Double?
}

struct TalkRealtimeClientCloseParams: Encodable {
    let sessionKey: String
    let voiceSessionId: String
}

struct TalkRealtimeToolCallResponse: Decodable {
    let runId: String?
    let idempotencyKey: String?
    let agentId: String?
    let agentSessionKey: String?
}

struct TalkRealtimeServerEvent: Decodable {
    let type: String
    let error: TalkRealtimeServerError?
    let reason: String?
    let itemId: String?
    let item: TalkRealtimeServerItem?
    let turn: TalkRealtimeServerTurn?
    let callId: String?
    let name: String?
    let delta: String?
    let arguments: String?
    let transcript: String?
    let text: String?

    enum CodingKeys: String, CodingKey {
        case type
        case error
        case reason
        case itemId = "item_id"
        case item
        case turn
        case callId = "call_id"
        case name
        case delta
        case arguments
        case transcript
        case text
    }

    var resolvedItemId: String? {
        self.itemId ?? self.item?.id
    }

    var resolvedCallId: String? {
        self.callId ?? self.item?.callId
    }

    var resolvedName: String? {
        self.name ?? self.item?.name
    }

    var resolvedArguments: String? {
        self.arguments ?? self.item?.arguments
    }

    var isMaximumDurationError: Bool {
        guard self.type == "error", let message = self.error?.message?.lowercased() else { return false }
        return message.contains("session") && message.contains("maximum duration")
    }

    var sessionCloseFailureStatus: String? {
        guard self.type == "session.closed" else { return nil }
        return switch self.reason {
        case "content": "Realtime error"
        case "connection_lost": "Realtime disconnected"
        default: nil
        }
    }
}

struct TalkRealtimeServerError: Decodable {
    let message: String?
}

struct TalkRealtimeServerTurn: Decodable {
    let id: String?
    let role: String?
    let transcript: String?
}

struct TalkRealtimeServerItem: Decodable {
    let id: String?
    let type: String?
    let text: String?
    let callId: String?
    let name: String?
    let arguments: String?

    enum CodingKeys: String, CodingKey {
        case id
        case type
        case text
        case callId = "call_id"
        case name
        case arguments
    }
}

/// Live speech overlaps, so caption fragments accumulate independently for each speaker.
struct TalkRealtimeLiveCaptionBuffer {
    struct Entry {
        let role: TalkRealtimeTranscriptRole
        var text: String
    }

    private var entries: [Entry] = []

    mutating func append(_ event: TalkRealtimeServerEvent) -> Entry? {
        let role: TalkRealtimeTranscriptRole
        switch event.type {
        case "session.input_transcript.delta": role = .user
        case "session.output_transcript.delta": role = .assistant
        default: return nil
        }
        guard let delta = event.delta, !delta.isEmpty else { return nil }
        if let index = self.entries.firstIndex(where: { $0.role == role }) {
            self.entries[index].text = String((self.entries[index].text + delta).suffix(8192))
            return self.entries[index]
        }
        let entry = Entry(role: role, text: String(delta.suffix(8192)))
        self.entries.append(entry)
        return entry
    }

    mutating func reset() {
        self.entries.removeAll(keepingCapacity: true)
    }
}
