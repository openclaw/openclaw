#if DEBUG
import Foundation

extension DashboardWindowController {
    struct NavigationFailureObservation {
        enum Kind {
            case didFail
            case didFailProvisionalNavigation
        }

        let ordinal: UInt64
        let kind: Kind
        let errorDomain: String
        let errorCode: Int
        let navigationIsNil: Bool
        let loadGeneration: UInt64
        let navigationGeneration: UInt64

        static func recording(
            _ error: Error,
            navigationIsNil: Bool,
            kind: Kind,
            previous: Self?,
            loadGeneration: UInt64,
            navigationGeneration: UInt64) -> Self?
        {
            let nsError = error as NSError
            // Expected cancellation must not replace the terminal failure that explains lost readiness.
            if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return previous }
            return Self(
                ordinal: (previous?.ordinal ?? 0) &+ 1,
                kind: kind,
                errorDomain: nsError.domain,
                errorCode: nsError.code,
                navigationIsNil: navigationIsNil,
                loadGeneration: loadGeneration,
                navigationGeneration: navigationGeneration)
        }
    }
}
#endif
