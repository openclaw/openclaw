import Foundation
import SwiftUI

public struct OpenClawChatAttentionRequest: Identifiable, Equatable, Sendable {
    public enum Kind: String, Hashable, Sendable {
        case question
        case approval
    }

    public let id: String
    public let kind: Kind
    public let sessionKey: String?
    public let agentID: String?
    public let createdAtMs: Double
    public let expiresAtMs: Double
    public let preview: String
    public let count: Int
    public let ownerID: String?

    public init(
        id: String,
        kind: Kind,
        sessionKey: String?,
        agentID: String?,
        createdAtMs: Double,
        expiresAtMs: Double,
        preview: String,
        count: Int = 1,
        ownerID: String? = nil)
    {
        self.id = id
        self.kind = kind
        self.sessionKey = sessionKey
        self.agentID = agentID
        self.createdAtMs = createdAtMs
        self.expiresAtMs = expiresAtMs
        self.preview = Self.normalizedPreview(preview)
        self.count = count
        self.ownerID = ownerID
    }

    private static func normalizedPreview(_ preview: String) -> String {
        let line = preview.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard line.utf16.count > 240 else { return line }
        var result = ""
        var length = 0
        for scalar in line.unicodeScalars {
            let scalarLength = scalar.value > 0xFFFF ? 2 : 1
            guard length + scalarLength <= 239 else { break }
            result.unicodeScalars.append(scalar)
            length += scalarLength
        }
        return result + "…"
    }
}

public struct OpenClawChatAttentionSummary: Identifiable, Equatable, Sendable {
    public struct DisclosureIdentity: Hashable, Sendable {
        let ownerID: Data?
        let kind: OpenClawChatAttentionRequest.Kind
        let requestID: Data
        let sessionKey: Data?
        let createdAtMs: Double
    }

    public let kind: OpenClawChatAttentionRequest.Kind
    public let oldest: OpenClawChatAttentionRequest
    public let count: Int
    public var id: OpenClawChatAttentionRequest.Kind {
        self.kind
    }

    public var disclosureIdentity: DisclosureIdentity {
        DisclosureIdentity(
            ownerID: self.oldest.ownerID.map { Data($0.utf8) },
            kind: self.kind,
            requestID: Data(self.oldest.id.utf8),
            sessionKey: self.oldest.sessionKey.map { Data($0.utf8) },
            createdAtMs: self.oldest.createdAtMs)
    }

    public var title: String {
        self.kind == .question ? String(localized: "Waiting for answer") : String(localized: "Waiting for approval")
    }

    public var additionalRequestsText: String? {
        guard self.count > 1 else { return nil }
        if self.count == 2 {
            return self.kind == .question ? String(localized: "1 more question") : String(localized: "1 more approval")
        }
        return self.kind == .question
            ? String(format: String(localized: "%lld more questions"), self.count - 1)
            : String(format: String(localized: "%lld more approvals"), self.count - 1)
    }

    public var accessibilityText: String {
        [self.title, self.oldest.preview, self.additionalRequestsText]
            .compactMap(\.self).joined(separator: ". ")
    }
}

extension ChatSessionSidebarModel {
    @MainActor
    public static func attentionSummary(
        requests: [OpenClawChatAttentionRequest],
        sessions: [OpenClawChatSessionEntry],
        mainSessionKey: String,
        activeAgentID: String?,
        sessionRoutingContract: String?,
        now: Date = Date()) -> OpenClawChatAttentionSummary?
    {
        let nowMs = now.timeIntervalSince1970 * 1000
        let pending = requests.filter { request in
            guard request.expiresAtMs > nowMs, let source = request.sessionKey else { return false }
            return sessions.contains { session in
                let agentID = session.agentId ?? activeAgentID
                return self.isSessionInActiveAgentScope(
                    key: source, agentID: request.agentID, activeAgentID: agentID) &&
                    OpenClawChatViewModel.matchesCurrentSessionKey(
                        incoming: source,
                        agentId: request.agentID,
                        current: session.key,
                        mainSessionKey: mainSessionKey,
                        activeAgentId: agentID,
                        sessionRoutingContract: sessionRoutingContract)
            }
        }.sorted {
            if $0.createdAtMs != $1.createdAtMs { return $0.createdAtMs < $1.createdAtMs }
            if !Data($0.id.utf8).elementsEqual(Data($1.id.utf8)) {
                return $0.id.utf8.lexicographicallyPrecedes($1.id.utf8)
            }
            return $0.kind.rawValue < $1.kind.rawValue
        }
        guard let oldest = pending.first else { return nil }
        var seen = Set<Data>()
        let requests = pending.filter { $0.kind == oldest.kind && seen.insert(Data($0.id.utf8)).inserted }
        return OpenClawChatAttentionSummary(
            kind: oldest.kind, oldest: oldest, count: requests.reduce(0) { $0 + $1.count })
    }
}

extension OpenClawChatViewModel {
    public var pendingQuestionAttentionRequests: [OpenClawChatAttentionRequest] {
        self.questionCards.compactMap { card in
            guard card.status() == .pending || card.status() == .submitting else { return nil }
            let record = card.record
            let preview = record.questions.first?.question.trimmingCharacters(in: .whitespacesAndNewlines)
            return OpenClawChatAttentionRequest(
                id: record.id,
                kind: .question,
                sessionKey: record.sessionkey,
                agentID: record.agentid,
                createdAtMs: Double(record.createdatms),
                expiresAtMs: Double(record.expiresatms),
                preview: preview.flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "Question needs an answer"),
                count: record.questions.count,
                ownerID: self.questionAttentionOwnerID.uuidString)
        }
    }
}

public struct OpenClawChatAttentionPresentation: Equatable, Sendable {
    private let targetID: Data
    private let requestID: OpenClawChatAttentionSummary.DisclosureIdentity

    public init(targetID: String, requestID: OpenClawChatAttentionSummary.DisclosureIdentity) {
        self.targetID = Data(targetID.utf8)
        self.requestID = requestID
    }
}

public struct OpenClawChatAttentionBadge: View {
    public let summary: OpenClawChatAttentionSummary
    private let targetID: String
    @Binding private var presentation: OpenClawChatAttentionPresentation?

    public init(
        summary: OpenClawChatAttentionSummary,
        targetID: String,
        presentation: Binding<OpenClawChatAttentionPresentation?>)
    {
        self.summary = summary
        self.targetID = targetID
        self._presentation = presentation
    }

    private var selection: OpenClawChatAttentionPresentation {
        OpenClawChatAttentionPresentation(targetID: self.targetID, requestID: self.summary.disclosureIdentity)
    }

    private var isPresented: Binding<Bool> {
        let selection = self.selection
        return Binding(
            get: { self.presentation == selection },
            set: { presented in
                if presented {
                    self.presentation = selection
                } else if self.presentation == selection {
                    self.presentation = nil
                }
            })
    }

    public var body: some View {
        Button {
            self.isPresented.wrappedValue.toggle()
        } label: {
            Image(systemName: self.summary.kind == .question ? "hand.raised.fill" : "checkmark.shield")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(OpenClawChatTheme.warning)
                #if os(iOS)
                .frame(width: 44, height: 44)
                #else
                .frame(width: 22, height: 22)
                #endif
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(self.summary.accessibilityText)
        .accessibilityHint(String(localized: "Show pending request details"))
        .accessibilityIdentifier("sidebar-attention-\(self.summary.kind.rawValue)")
        .help(self.summary.accessibilityText)
        .popover(isPresented: self.isPresented) {
            VStack(alignment: .leading, spacing: 10) {
                Text(self.summary.title)
                    .font(OpenClawChatTypography.body(size: 14, weight: .semibold, relativeTo: .body))
                    .lineLimit(nil)
                ViewThatFits(in: .vertical) {
                    self.preview
                    ScrollView { self.preview }
                }
                .frame(maxHeight: 280)
                if let additional = self.summary.additionalRequestsText {
                    Text(additional)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(nil)
                }
            }
            .padding(16)
            .frame(minWidth: 220, idealWidth: 300, maxWidth: 360, alignment: .leading)
            #if os(iOS)
            .presentationCompactAdaptation(.popover)
            #endif
        }
        .onChange(of: self.selection) { previous, _ in
            if self.presentation == previous { self.presentation = nil }
        }
        .onDisappear {
            if self.presentation == self.selection { self.presentation = nil }
        }
    }

    private var preview: some View {
        Text(verbatim: self.summary.oldest.preview)
            .font(OpenClawChatTypography.body)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .lineLimit(nil)
            .multilineTextAlignment(.leading)
            .textSelection(.enabled)
    }
}
