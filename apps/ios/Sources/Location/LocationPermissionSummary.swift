import CoreLocation

struct LocationAuthorizationSnapshot: Equatable, Sendable {
    var authorizationStatus: CLAuthorizationStatus
    var accuracyAuthorization: CLAccuracyAuthorization

    static let undetermined = LocationAuthorizationSnapshot(
        authorizationStatus: .notDetermined,
        accuracyAuthorization: .fullAccuracy)
}
