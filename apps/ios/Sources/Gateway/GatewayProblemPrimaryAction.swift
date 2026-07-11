import OpenClawKit
import UIKit

enum GatewayProblemPrimaryAction {
    static func title(
        for problem: GatewayConnectionProblem,
        retryTitle: String,
        resetTitle: String? = nil,
        nonRetryableTitle: String? = nil) -> String?
    {
        if problem.suggestsOnboardingReset, let resetTitle {
            return resetTitle
        }
        if problem.canTrustRotatedCertificate {
            return "Trust certificate"
        }
        if problem.kind == .protocolMismatch {
            return problem.actionLabel
        }
        if problem.retryable {
            return problem.actionLabel ?? retryTitle
        }
        return nonRetryableTitle
    }

    @MainActor
    static func handleProtocolMismatchIfNeeded(_ problem: GatewayConnectionProblem) -> Bool {
        guard problem.kind == .protocolMismatch else { return false }
        if let command = problem.actionCommand {
            UIPasteboard.general.string = command
            return true
        }
        if let url = problem.docsURL {
            UIApplication.shared.open(url)
        }
        return true
    }
}
