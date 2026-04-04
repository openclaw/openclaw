import CoreLocation
import Foundation
import OSLog
import OpenClawKit

/// Monitors significant location changes and pushes `location.update`
/// events to the gateway so the severance hook can determine whether
/// the user is at their configured work location.
@MainActor
enum SignificantLocationMonitor {
    nonisolated private static let logger = Logger(subsystem: "ai.openclaw.ios", category: "SignificantLocation")

    static func startIfNeeded(
        locationService: any LocationServicing,
        locationMode: OpenClawLocationMode,
        gateway: GatewayNodeSession,
        beforeSend: (@MainActor @Sendable () async -> Void)? = nil
    ) {
        guard locationMode == .always else { return }
        let status = locationService.authorizationStatus()
        guard status == .authorizedAlways else { return }
        locationService.startMonitoringSignificantLocationChanges { location in
            let lat = location.coordinate.latitude
            let lon = location.coordinate.longitude
            let accuracy = location.horizontalAccuracy
            logger.info("Significant location change detected")
            logger.debug("Location detail lat=\(lat) lon=\(lon) accuracyMeters=\(accuracy)")
            struct Payload: Codable {
                var lat: Double
                var lon: Double
                var accuracyMeters: Double
                var source: String?
            }
            let payload = Payload(
                lat: lat,
                lon: lon,
                accuracyMeters: accuracy,
                source: "ios-significant-location")
            guard let data = try? JSONEncoder().encode(payload),
                  let json = String(data: data, encoding: .utf8)
            else {
                logger.error("Failed to encode location payload")
                return
            }
            Task { @MainActor in
                if let beforeSend {
                    await beforeSend()
                }
                await gateway.sendEvent(event: "location.update", payloadJSON: json)
                logger.info("location.update sent to gateway")
            }
        }
    }
}
