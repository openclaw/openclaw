import CoreLocation
import Foundation
import MullusiKit
import UIKit

typealias MullusiCameraSnapResult = (format: String, base64: String, width: Int, height: Int)
typealias MullusiCameraClipResult = (format: String, base64: String, durationMs: Int, hasAudio: Bool)

protocol CameraServicing: Sendable {
    func listDevices() async -> [CameraController.CameraDeviceInfo]
    func snap(params: MullusiCameraSnapParams) async throws -> MullusiCameraSnapResult
    func clip(params: MullusiCameraClipParams) async throws -> MullusiCameraClipResult
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
    func ensureAuthorization(mode: MullusiLocationMode) async -> CLAuthorizationStatus
    func currentLocation(
        params: MullusiLocationGetParams,
        desiredAccuracy: MullusiLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    func startLocationUpdates(
        desiredAccuracy: MullusiLocationAccuracy,
        significantChangesOnly: Bool) -> AsyncStream<CLLocation>
    func stopLocationUpdates()
    func startMonitoringSignificantLocationChanges(onUpdate: @escaping @Sendable (CLLocation) -> Void)
    func stopMonitoringSignificantLocationChanges()
}

@MainActor
protocol DeviceStatusServicing: Sendable {
    func status() async throws -> MullusiDeviceStatusPayload
    func info() -> MullusiDeviceInfoPayload
}

protocol PhotosServicing: Sendable {
    func latest(params: MullusiPhotosLatestParams) async throws -> MullusiPhotosLatestPayload
}

protocol ContactsServicing: Sendable {
    func search(params: MullusiContactsSearchParams) async throws -> MullusiContactsSearchPayload
    func add(params: MullusiContactsAddParams) async throws -> MullusiContactsAddPayload
}

protocol CalendarServicing: Sendable {
    func events(params: MullusiCalendarEventsParams) async throws -> MullusiCalendarEventsPayload
    func add(params: MullusiCalendarAddParams) async throws -> MullusiCalendarAddPayload
}

protocol RemindersServicing: Sendable {
    func list(params: MullusiRemindersListParams) async throws -> MullusiRemindersListPayload
    func add(params: MullusiRemindersAddParams) async throws -> MullusiRemindersAddPayload
}

protocol MotionServicing: Sendable {
    func activities(params: MullusiMotionActivityParams) async throws -> MullusiMotionActivityPayload
    func pedometer(params: MullusiPedometerParams) async throws -> MullusiPedometerPayload
}

struct WatchMessagingStatus: Sendable, Equatable {
    var supported: Bool
    var paired: Bool
    var appInstalled: Bool
    var reachable: Bool
    var activationState: String
}

struct WatchQuickReplyEvent: Sendable, Equatable {
    var replyId: String
    var promptId: String
    var actionId: String
    var actionLabel: String?
    var sessionKey: String?
    var note: String?
    var sentAtMs: Int?
    var transport: String
}

struct WatchNotificationSendResult: Sendable, Equatable {
    var deliveredImmediately: Bool
    var queuedForDelivery: Bool
    var transport: String
}

protocol WatchMessagingServicing: AnyObject, Sendable {
    func status() async -> WatchMessagingStatus
    func setReplyHandler(_ handler: (@Sendable (WatchQuickReplyEvent) -> Void)?)
    func sendNotification(
        id: String,
        params: MullusiWatchNotifyParams) async throws -> WatchNotificationSendResult
}

extension CameraController: CameraServicing {}
extension ScreenRecordService: ScreenRecordingServicing {}
extension LocationService: LocationServicing {}
