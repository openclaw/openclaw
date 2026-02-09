import CoreLocation
import Foundation
import EasyHubKit
import UIKit

protocol CameraServicing: Sendable {
    func listDevices() async -> [CameraController.CameraDeviceInfo]
    func snap(params: EasyHubCameraSnapParams) async throws -> (format: String, base64: String, width: Int, height: Int)
    func clip(params: EasyHubCameraClipParams) async throws -> (format: String, base64: String, durationMs: Int, hasAudio: Bool)
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
    func ensureAuthorization(mode: EasyHubLocationMode) async -> CLAuthorizationStatus
    func currentLocation(
        params: EasyHubLocationGetParams,
        desiredAccuracy: EasyHubLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
}

protocol DeviceStatusServicing: Sendable {
    func status() async throws -> EasyHubDeviceStatusPayload
    func info() -> EasyHubDeviceInfoPayload
}

protocol PhotosServicing: Sendable {
    func latest(params: EasyHubPhotosLatestParams) async throws -> EasyHubPhotosLatestPayload
}

protocol ContactsServicing: Sendable {
    func search(params: EasyHubContactsSearchParams) async throws -> EasyHubContactsSearchPayload
    func add(params: EasyHubContactsAddParams) async throws -> EasyHubContactsAddPayload
}

protocol CalendarServicing: Sendable {
    func events(params: EasyHubCalendarEventsParams) async throws -> EasyHubCalendarEventsPayload
    func add(params: EasyHubCalendarAddParams) async throws -> EasyHubCalendarAddPayload
}

protocol RemindersServicing: Sendable {
    func list(params: EasyHubRemindersListParams) async throws -> EasyHubRemindersListPayload
    func add(params: EasyHubRemindersAddParams) async throws -> EasyHubRemindersAddPayload
}

protocol MotionServicing: Sendable {
    func activities(params: EasyHubMotionActivityParams) async throws -> EasyHubMotionActivityPayload
    func pedometer(params: EasyHubPedometerParams) async throws -> EasyHubPedometerPayload
}

extension CameraController: CameraServicing {}
extension ScreenRecordService: ScreenRecordingServicing {}
extension LocationService: LocationServicing {}
