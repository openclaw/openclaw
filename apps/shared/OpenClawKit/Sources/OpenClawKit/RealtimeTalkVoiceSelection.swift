import Foundation
import OpenClawProtocol

/// Coordinates a negotiated voice replacement; the call owner retains audio and transcript lifetimes.
@MainActor
public final class RealtimeTalkVoiceSelection {
    public private(set) var selectedVoice: String?
    public var isChanging: Bool {
        self.pending != nil
    }

    private final class Change {
        let event: TalkVoiceChangeEvent
        var cancellation: Task<Void, Never>?
        var timeout: Task<Void, Never>?

        init(_ event: TalkVoiceChangeEvent) {
            self.event = event
        }
    }

    private let sessionKey: String
    private let currentVoiceSessionID: @MainActor () -> String?
    private let isCurrent: @MainActor (RealtimeTalkVoiceSelection) -> Bool
    private let replace: @MainActor (TalkVoiceChangeEvent) async throws -> String
    private let complete: @MainActor (TalkVoiceCompleteParams) async throws -> Void
    private let cancel: @MainActor () async -> Void
    private let onFailure: @MainActor (Error) -> Void
    private let onApplied: @MainActor (String) -> Void
    private var active = true
    private var pending: Change?

    public init(
        sessionKey: String,
        selectedVoice: String? = nil,
        currentVoiceSessionID: @escaping @MainActor () -> String?,
        isCurrent: @escaping @MainActor (RealtimeTalkVoiceSelection) -> Bool,
        replace: @escaping @MainActor (TalkVoiceChangeEvent) async throws -> String,
        complete: @escaping @MainActor (TalkVoiceCompleteParams) async throws -> Void,
        cancel: @escaping @MainActor () async -> Void,
        onFailure: @escaping @MainActor (Error) -> Void,
        onApplied: @escaping @MainActor (String) -> Void = { _ in })
    {
        self.sessionKey = sessionKey
        self.selectedVoice = selectedVoice
        self.currentVoiceSessionID = currentVoiceSessionID
        self.isCurrent = isCurrent
        self.replace = replace
        self.complete = complete
        self.cancel = cancel
        self.onFailure = onFailure
        self.onApplied = onApplied
    }

    public func handle(_ event: EventFrame) {
        guard self.active, self.isCurrent(self), event.event == "talk.voice.change",
              let payload = event.payload,
              let change = try? GatewayPayloadDecoding.decode(payload, as: TalkVoiceChangeEvent.self),
              change.sessionkey == self.sessionKey,
              !change.changeid.isEmpty, !change.voicesessionid.isEmpty, !change.voice.isEmpty,
              let phase = change.phase.value as? String
        else { return }
        if phase == "cancelled" {
            if let pending, pending.event.changeid == change.changeid,
               pending.event.voicesessionid == change.voicesessionid
            {
                self.cancelChange(pending, error: CancellationError())
            }
            return
        }
        guard phase == "requested", self.pending == nil,
              self.currentVoiceSessionID() == change.voicesessionid
        else { return }
        let pending = Change(change)
        self.pending = pending
        pending.timeout = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(60)) } catch { return }
            self?.cancelChange(pending, error: CancellationError())
        }
        Task { @MainActor [weak self] in await self?.perform(pending) }
    }

    private func cancelChange(_ change: Change, error: Error) {
        guard self.pending === change, change.cancellation == nil else { return }
        change.timeout?.cancel()
        change.cancellation = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.clear(change) }
            guard self.active, self.isCurrent(self) else { return }
            await self.cancel()
            if self.active, self.isCurrent(self) { self.onFailure(error) }
        }
    }

    public func invalidate() {
        self.active = false
        if let pending { self.clear(pending) }
    }

    private func clear(_ change: Change) {
        change.timeout?.cancel()
        change.timeout = nil
        if self.pending === change { self.pending = nil }
    }

    private func owns(_ change: Change) -> Bool {
        self.active && self.isCurrent(self) && self.pending === change && change.cancellation == nil
    }

    private func perform(_ change: Change) async {
        let event = change.event
        var replacementID: String?
        do {
            guard self.owns(change) else { throw CancellationError() }
            let id = try await replace(event)
            replacementID = id
            guard self.owns(change), !id.isEmpty, id != event.voicesessionid,
                  self.currentVoiceSessionID() == id
            else { throw CancellationError() }
            try await self.complete(TalkVoiceCompleteParams(
                changeid: event.changeid,
                voicesessionid: id,
                outcome: AnyCodable("ready")))
            guard self.owns(change) else { return }
            self.selectedVoice = event.voice
            self.clear(change)
            self.onApplied(event.voice)
        } catch {
            self.cancelChange(change, error: error)
            await change.cancellation?.value
            // Closing first keeps the Gateway's replacement classification alive during teardown.
            try? await self.complete(TalkVoiceCompleteParams(
                changeid: event.changeid,
                voicesessionid: replacementID,
                outcome: AnyCodable("failed"),
                error: error.localizedDescription))
        }
    }
}
