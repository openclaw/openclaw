import CoreLocation
import Foundation
import OpenClawKit
import UIKit

protocol CameraServicing: Sendable {
    func listDevices() async -> [CameraController.CameraDeviceInfo]
    func snap(params: OpenClawCameraSnapParams) async throws -> (format: String, base64: String, width: Int, height: Int)
    func clip(params: OpenClawCameraClipParams) async throws -> (format: String, base64: String, durationMs: Int, hasAudio: Bool)
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
    func ensureAuthorization(mode: OpenClawLocationMode) async -> CLAuthorizationStatus
    func currentLocation(
        params: OpenClawLocationGetParams,
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
}

protocol DeviceStatusServicing: Sendable {
    func status() async throws -> OpenClawDeviceStatusPayload
    func info() -> OpenClawDeviceInfoPayload
}

protocol PhotosServicing: Sendable {
    func latest(params: OpenClawPhotosLatestParams) async throws -> OpenClawPhotosLatestPayload
}

protocol ContactsServicing: Sendable {
    func search(params: OpenClawContactsSearchParams) async throws -> OpenClawContactsSearchPayload
    func add(params: OpenClawContactsAddParams) async throws -> OpenClawContactsAddPayload
}

protocol CalendarServicing: Sendable {
    func events(params: OpenClawCalendarEventsParams) async throws -> OpenClawCalendarEventsPayload
    func add(params: OpenClawCalendarAddParams) async throws -> OpenClawCalendarAddPayload
}

protocol RemindersServicing: Sendable {
    func list(params: OpenClawRemindersListParams) async throws -> OpenClawRemindersListPayload
    func add(params: OpenClawRemindersAddParams) async throws -> OpenClawRemindersAddPayload
}

protocol MotionServicing: Sendable {
    func activities(params: OpenClawMotionActivityParams) async throws -> OpenClawMotionActivityPayload
    func pedometer(params: OpenClawPedometerParams) async throws -> OpenClawPedometerPayload
}

extension CameraController: CameraServicing {}
extension ScreenRecordService: ScreenRecordingServicing {}
extension LocationService: LocationServicing {}
