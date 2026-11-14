import Foundation

extension Date {
    /// Synthetic browser sessions outlive the CI job, so a starved runner cannot expire a
    /// session in a test that is not about expiry.
    static var fixtureSessionExpiry: Date {
        Date().addingTimeInterval(24 * 60 * 60)
    }
}
