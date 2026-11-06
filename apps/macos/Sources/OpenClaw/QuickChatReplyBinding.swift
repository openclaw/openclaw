import Observation
import OpenClawChatUI

@MainActor
@Observable
final class QuickChatReplyBinding {
    typealias ViewModelFactory = @MainActor (OpenClawChatSessionTarget) -> OpenClawChatViewModel

    private(set) var route: OpenClawChatSessionTarget?
    private(set) var isExpanded = false
    private(set) var viewModel: OpenClawChatViewModel?
    private(set) var isPastingReply = false
    private(set) var pasteStatusMessage: String?
    private(set) var disclosureRevision: UInt64 = 0
    @ObservationIgnored private var preparedRoute: OpenClawChatSessionTarget?

    @ObservationIgnored private let viewModelFactory: ViewModelFactory

    init(viewModelFactory: @escaping ViewModelFactory = QuickChatReplyBinding.makeViewModel) {
        self.viewModelFactory = viewModelFactory
    }

    /// Prepare the reply consumer before dispatch while keeping it hidden until show(route:).
    /// Subscription starts asynchronously; full snapshots and history bootstrap recover earlier turns.
    func prepare(route: OpenClawChatSessionTarget) {
        guard self.preparedRoute != route else { return }
        self.preparedRoute = route
        self.viewModel = self.viewModelFactory(route)
    }

    func show(route: OpenClawChatSessionTarget) {
        self.prepare(route: route)
        self.route = route
        self.isExpanded = true
        self.disclosureRevision &+= 1
    }

    func rebindIfActive(route: OpenClawChatSessionTarget) {
        // A target change retires hidden context without expanding the conversation.
        guard self.isExpanded else {
            if self.preparedRoute != route { self.clear() }
            return
        }
        self.show(route: route)
    }

    func hide() {
        self.isExpanded = false
        self.disclosureRevision &+= 1
    }

    func clear() {
        self.disclosureRevision &+= 1
        self.route = nil
        self.isExpanded = false
        self.preparedRoute = nil
        self.viewModel = nil
        self.isPastingReply = false
        self.pasteStatusMessage = nil
    }

    func beginPaste() -> Bool {
        guard !self.isPastingReply else { return false }
        self.isPastingReply = true
        self.pasteStatusMessage = nil
        return true
    }

    func finishPaste(message: String? = nil) {
        self.isPastingReply = false
        self.pasteStatusMessage = message
    }

    static func makeViewModel(route: OpenClawChatSessionTarget) -> OpenClawChatViewModel {
        let transport = MacGatewayChatTransport(defaultGlobalAgentID: route.agentID)
        return OpenClawChatViewModel(
            sessionKey: route.sessionKey,
            transport: transport,
            activeAgentId: route.agentID)
    }
}
