import OpenClawChatUI
import OpenClawKit
import UIKit

enum GatewayProblemPrimaryAction {
    /// What the primary action does for a problem, in the order the banner's handler checks.
    enum Route: Equatable {
        case resetOnboarding
        case trustCertificate
        case protocolMismatch
        case retry
        case openSettings
    }

    static func route(for problem: GatewayConnectionProblem) -> Route {
        if problem.suggestsOnboardingReset { return .resetOnboarding }
        if problem.canTrustRotatedCertificate { return .trustCertificate }
        if problem.kind == .protocolMismatch { return .protocolMismatch }
        return problem.retryable ? .retry : .openSettings
    }

    static func title(
        for problem: GatewayConnectionProblem,
        retryTitle: String,
        resetTitle: String? = nil,
        nonRetryableTitle: String? = nil) -> String?
    {
        if problem.suggestsOnboardingReset, let resetTitle {
            return String(localized: String.LocalizationValue(resetTitle))
        }
        if problem.canTrustRotatedCertificate {
            return String(localized: "Trust certificate")
        }
        if problem.kind == .protocolMismatch {
            return problem.localizedActionLabel
        }
        if problem.retryable {
            return problem.localizedActionLabel
                ?? String(localized: String.LocalizationValue(retryTitle))
        }
        return nonRetryableTitle.map { String(localized: String.LocalizationValue($0)) }
    }

    @MainActor
    static func handleProtocolMismatchIfNeeded(
        _ problem: GatewayConnectionProblem,
        toasts: OpenClawToastPresenter) -> Bool
    {
        guard problem.kind == .protocolMismatch else { return false }
        if let command = problem.actionCommand {
            UIPasteboard.general.string = command
            // The command stays in the problem's details, where Copy command is the other way.
            toasts.post(.copied(String(localized: "Command copied")))
            return true
        }
        if let url = problem.docsURL {
            UIApplication.shared.open(url)
        }
        return true
    }
}
