import Observation
import OpenClawChatUI

@MainActor
@Observable
final class QuickChatReplyBinding {
    typealias ViewModelFactory = @MainActor (QuickChatRoutingTarget) -> OpenClawChatViewModel

    private(set) var route: QuickChatRoutingTarget?
    private(set) var viewModel: OpenClawChatViewModel?
    @ObservationIgnored private var preparedRoute: QuickChatRoutingTarget?

    @ObservationIgnored private let viewModelFactory: ViewModelFactory

    init(viewModelFactory: @escaping ViewModelFactory = QuickChatReplyBinding.makeViewModel) {
        self.viewModelFactory = viewModelFactory
    }

    /// Starts the transport consumer before the send is dispatched so no early
    /// delta/final frame is missed; the reply area stays hidden until show(route:).
    func prepare(route: QuickChatRoutingTarget) {
        guard self.preparedRoute != route || self.viewModel == nil else { return }
        self.preparedRoute = route
        self.viewModel = self.viewModelFactory(route)
    }

    func show(route: QuickChatRoutingTarget) {
        self.prepare(route: route)
        self.route = route
    }

    func rebindIfActive(route: QuickChatRoutingTarget) {
        // Only a VISIBLE reply rebinds; hidden prepared state from a failed send must
        // not be promoted into an expanded transcript by a later target change.
        guard self.route != nil else { return }
        self.show(route: route)
    }

    func clear() {
        self.route = nil
        self.preparedRoute = nil
        self.viewModel = nil
    }

    private static func makeViewModel(route: QuickChatRoutingTarget) -> OpenClawChatViewModel {
        let transport = MacGatewayChatTransport(defaultGlobalAgentID: route.agentID)
        return OpenClawChatViewModel(
            sessionKey: route.sessionKey,
            transport: transport,
            activeAgentId: route.agentID)
    }
}
