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
    var voiceChangeId: String?
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
        guard self.type == "error", let message = error?.message?.lowercased() else { return false }
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
    struct ContentPart: Decodable {
        let type: String?
    }

    let id: String?
    let type: String?
    let role: String?
    let content: [ContentPart]?
    let text: String?
    let callId: String?
    let name: String?
    let arguments: String?

    enum CodingKeys: String, CodingKey {
        case id
        case type
        case role
        case content
        case text
        case callId = "call_id"
        case name
        case arguments
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decodeIfPresent(String.self, forKey: .id)
        self.type = try container.decodeIfPresent(String.self, forKey: .type)
        // Ordering metadata is optional: an unexpected shape must not drop the whole event.
        self.role = try? container.decodeIfPresent(String.self, forKey: .role)
        self.content = try? container.decodeIfPresent([ContentPart].self, forKey: .content)
        self.text = try container.decodeIfPresent(String.self, forKey: .text)
        self.callId = try container.decodeIfPresent(String.self, forKey: .callId)
        self.name = try container.decodeIfPresent(String.self, forKey: .name)
        self.arguments = try container.decodeIfPresent(String.self, forKey: .arguments)
    }
}

/// Finals finish out of conversation order: user speech recognition often completes after the
/// reply's transcript. Each turn reserves a slot when it starts, and finals persist in slot order.
struct TalkRealtimeTranscriptOrder {
    struct Entry: Equatable {
        let role: TalkRealtimeTranscriptRole
        let text: String
    }

    private struct Slot {
        let seq: Int
        /// Provider conversation item; nil for frameless turns, which have no item contract.
        let itemId: String?
        let role: TalkRealtimeTranscriptRole
        var settled = false
        var text: String?
    }

    private static let maxPendingSlots = 1024
    /// Released ids still deduplicate a late second announcement of the same item.
    private static let maxRecentItemIds = 256
    private var slots: [Slot] = []
    private var recentItemIds: [String] = []
    private var nextSeq = 0

    /// The unfinished turn that a settled final waits behind, if any.
    var holdingTurn: Int? {
        guard let blocked = slots.firstIndex(where: { !$0.settled }),
              self.slots[blocked...].contains(where: \.settled)
        else { return nil }
        return self.slots[blocked].seq
    }

    var isHolding: Bool {
        self.holdingTurn != nil
    }

    /// Reserves slots when turns start; settles assistant items that end without a transcript.
    mutating func observe(_ event: TalkRealtimeServerEvent) -> [Entry] {
        switch event.type {
        case "input_audio_buffer.committed":
            self.reserve(itemId: event.itemId, role: .user)
        case "conversation.item.added", "conversation.item.created":
            guard let item = event.item, item.type == "message" else { return [] }
            if item.role == "assistant" {
                self.reserve(itemId: item.id, role: .assistant)
            } else if item.role == "user", item.content?.contains(where: { $0.type == "input_audio" }) == true {
                self.reserve(itemId: item.id, role: .user)
            }
        case "output_audio_buffer.cleared":
            // Explicit interruption ends the frameless reply; interleaved text alone does not.
            for index in self.slots.indices where self.slots[index].itemId == nil &&
                self.slots[index].role == .assistant && !self.slots[index].settled
            {
                self.slots[index].settled = true
            }
            return self.releaseReady()
        case "input_transcript.added":
            return self.reserveFrameless(role: .user)
        case "output_transcript.added":
            return self.reserveFrameless(role: .assistant)
        case "conversation.item.done", "response.output_item.done":
            // Interrupted replies can finish an assistant item without any transcript.
            guard event.item?.type == "message", event.item?.role == "assistant" else { return [] }
            return self.settleReserved(itemId: event.item?.id, text: nil) ?? []
        case "conversation.item.input_audio_transcription.failed":
            return self.settleReserved(itemId: event.itemId, text: nil) ?? []
        default:
            break
        }
        return []
    }

    /// Records a final transcript and returns every final now ready, in conversation order.
    mutating func settle(role: TalkRealtimeTranscriptRole, text: String, itemId: String?) -> [Entry] {
        if let itemId {
            // A final for an item with no pending slot keeps provider arrival order.
            return self.settleReserved(itemId: itemId, text: text) ?? [Entry(role: role, text: text)]
        }
        if let index = slots.firstIndex(where: { $0.itemId == nil && $0.role == role && !$0.settled }) {
            self.slots[index].settled = true
            self.slots[index].text = text
        } else {
            self.append(itemId: nil, role: role, settled: true, text: text)
        }
        return self.releaseReady()
    }

    /// Stops waiting for turns that stalled ahead of a finished one. Their late finals, if any,
    /// keep arrival order instead of holding every later final indefinitely.
    mutating func releaseHeld() -> [Entry] {
        guard let lastSettled = slots.lastIndex(where: \.settled) else { return [] }
        for slot in self.slots[...lastSettled] where !slot.settled {
            self.remember(slot.itemId)
        }
        self.slots = self.slots.enumerated()
            .filter { $0.offset > lastSettled || $0.element.settled }
            .map(\.element)
        return self.releaseReady()
    }

    /// A timeout abandons only its blocker; newer unfinished turns retain their own grace period.
    mutating func expireHoldingTurn() -> [Entry] {
        guard let turn = self.holdingTurn,
              let index = self.slots.firstIndex(where: { $0.seq == turn }) else { return [] }
        self.remember(self.slots[index].itemId)
        self.slots.remove(at: index)
        return self.releaseReady()
    }

    mutating func reset() {
        self.slots.removeAll()
        self.recentItemIds.removeAll()
    }

    private mutating func reserve(itemId: String?, role: TalkRealtimeTranscriptRole) {
        guard let itemId, !itemId.isEmpty, self.slots.count < Self.maxPendingSlots,
              !self.recentItemIds.contains(itemId), !self.slots.contains(where: { $0.itemId == itemId })
        else { return }
        self.append(itemId: itemId, role: role)
    }

    private mutating func reserveFrameless(role: TalkRealtimeTranscriptRole) -> [Entry] {
        // Interleaved fragments still belong to the same unfinished turn.
        guard !self.slots.contains(where: { $0.itemId == nil && $0.role == role && !$0.settled }) else {
            return []
        }
        guard self.slots.count < Self.maxPendingSlots else { return self.releaseReady() }
        self.append(itemId: nil, role: role)
        return self.releaseReady()
    }

    /// nil when the item has no pending slot.
    private mutating func settleReserved(itemId: String?, text: String?) -> [Entry]? {
        guard let itemId, let index = slots.firstIndex(where: { $0.itemId == itemId }) else { return nil }
        // Text can follow an empty item completion; a pending slot keeps it either way.
        if !self.slots[index].settled || self.slots[index].text == nil {
            self.slots[index].settled = true
            self.slots[index].text = self.slots[index].text ?? text
        }
        return self.releaseReady()
    }

    private mutating func append(
        itemId: String?,
        role: TalkRealtimeTranscriptRole,
        settled: Bool = false,
        text: String? = nil)
    {
        self.nextSeq += 1
        self.slots.append(Slot(seq: self.nextSeq, itemId: itemId, role: role, settled: settled, text: text))
    }

    private mutating func remember(_ itemId: String?) {
        guard let itemId else { return }
        self.recentItemIds.append(itemId)
        if self.recentItemIds.count > Self.maxRecentItemIds {
            self.recentItemIds.removeFirst(self.recentItemIds.count - Self.maxRecentItemIds)
        }
    }

    private mutating func releaseReady() -> [Entry] {
        var ready: [Entry] = []
        while let head = slots.first, head.settled {
            self.slots.removeFirst()
            self.remember(head.itemId)
            if let text = head.text, !text.isEmpty {
                ready.append(Entry(role: head.role, text: text))
            }
        }
        return ready
    }
}

/// Live speech overlaps, so caption fragments accumulate independently for each speaker.
struct TalkRealtimeLiveCaptionBuffer {
    struct Entry {
        let role: TalkRealtimeTranscriptRole
        let text: String
    }

    private var textByRole: [TalkRealtimeTranscriptRole: String] = [:]

    mutating func append(_ event: TalkRealtimeServerEvent) -> Entry? {
        let role: TalkRealtimeTranscriptRole
        switch event.type {
        case "session.input_transcript.delta": role = .user
        case "session.output_transcript.delta": role = .assistant
        default: return nil
        }
        guard let delta = event.delta, !delta.isEmpty else { return nil }
        let text = String(((textByRole[role] ?? "") + delta).suffix(8192))
        self.textByRole[role] = text
        return Entry(role: role, text: text)
    }

    mutating func reset() {
        self.textByRole.removeAll(keepingCapacity: true)
    }
}
