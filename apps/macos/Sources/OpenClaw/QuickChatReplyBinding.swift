import Observation
import OpenClawChatUI

@MainActor
@Observable
final class QuickChatReplyBinding {
    typealias ViewModelFactory = @MainActor (QuickChatRoutingTarget) -> OpenClawChatViewModel

    private(set) var route: QuickChatRoutingTarget?
    private(set) var viewModel: OpenClawChatViewModel?

    @ObservationIgnored private let viewModelFactory: ViewModelFactory

    init(viewModelFactory: @escaping ViewModelFactory = QuickChatReplyBinding.makeViewModel) {
        self.viewModelFactory = viewModelFactory
    }

    func show(route: QuickChatRoutingTarget) {
        guard self.route != route || self.viewModel == nil else { return }
        self.route = route
        self.viewModel = self.viewModelFactory(route)
    }

    func rebindIfActive(route: QuickChatRoutingTarget) {
        guard self.viewModel != nil else { return }
        self.show(route: route)
    }

    func clear() {
        self.route = nil
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
