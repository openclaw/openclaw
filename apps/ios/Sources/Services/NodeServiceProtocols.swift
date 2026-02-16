import CoreLocation
import Foundation
import SmartAgentNeoKit
import UIKit

protocol CameraServicing: Sendable {
    func listDevices() async -> [CameraController.CameraDeviceInfo]
    func snap(params: SmartAgentNeoCameraSnapParams) async throws -> (format: String, base64: String, width: Int, height: Int)
    func clip(params: SmartAgentNeoCameraClipParams) async throws -> (format: String, base64: String, durationMs: Int, hasAudio: Bool)
}

protocol ScreenRecordingServicing: Sendable {
    func record(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> String
}

@MainActor
protocol LocationServicing: Sendable {
    func authorizationStatus() -> CLAuthorizationStatus
    func accuracyAuthorization() -> CLAccuracyAuthorization
    func ensureAuthorization(mode: SmartAgentNeoLocationMode) async -> CLAuthorizationStatus
    func currentLocation(
        params: SmartAgentNeoLocationGetParams,
        desiredAccuracy: SmartAgentNeoLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    func startLocationUpdates(
        desiredAccuracy: SmartAgentNeoLocationAccuracy,
        significantChangesOnly: Bool) -> AsyncStream<CLLocation>
    func stopLocationUpdates()
    func startMonitoringSignificantLocationChanges(onUpdate: @escaping @Sendable (CLLocation) -> Void)
    func stopMonitoringSignificantLocationChanges()
}

protocol DeviceStatusServicing: Sendable {
    func status() async throws -> SmartAgentNeoDeviceStatusPayload
    func info() -> SmartAgentNeoDeviceInfoPayload
}

protocol PhotosServicing: Sendable {
    func latest(params: SmartAgentNeoPhotosLatestParams) async throws -> SmartAgentNeoPhotosLatestPayload
}

protocol ContactsServicing: Sendable {
    func search(params: SmartAgentNeoContactsSearchParams) async throws -> SmartAgentNeoContactsSearchPayload
    func add(params: SmartAgentNeoContactsAddParams) async throws -> SmartAgentNeoContactsAddPayload
}

protocol CalendarServicing: Sendable {
    func events(params: SmartAgentNeoCalendarEventsParams) async throws -> SmartAgentNeoCalendarEventsPayload
    func add(params: SmartAgentNeoCalendarAddParams) async throws -> SmartAgentNeoCalendarAddPayload
}

protocol RemindersServicing: Sendable {
    func list(params: SmartAgentNeoRemindersListParams) async throws -> SmartAgentNeoRemindersListPayload
    func add(params: SmartAgentNeoRemindersAddParams) async throws -> SmartAgentNeoRemindersAddPayload
}

protocol MotionServicing: Sendable {
    func activities(params: SmartAgentNeoMotionActivityParams) async throws -> SmartAgentNeoMotionActivityPayload
    func pedometer(params: SmartAgentNeoPedometerParams) async throws -> SmartAgentNeoPedometerPayload
}

extension CameraController: CameraServicing {}
extension ScreenRecordService: ScreenRecordingServicing {}
extension LocationService: LocationServicing {}
