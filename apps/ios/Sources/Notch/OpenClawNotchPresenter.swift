import TopNotch
import UIKit

@MainActor
enum OpenClawNotchPresenter {
    private static var didShowNotch = false

    static func showIfNeeded() {
        if OpenClawNotchPresenter.didShowNotch { return }
        let exclusionRect = TopNotchManager.exclusionRect
        guard exclusionRect != .zero else { return }
        let config = TopNotchConfiguration(
            animationDuration: 0,
            shouldAnimate: false,
            shouldHideForTaskSwitcher: true,
            enableLogs: false)
        let view = OpenClawNotchLogoView(frame: CGRect(origin: .zero, size: exclusionRect.size))
        TopNotchManager.shared.show(customView: view, with: config)
        OpenClawNotchPresenter.didShowNotch = TopNotchManager.shared.isNotchVisible
    }
}
