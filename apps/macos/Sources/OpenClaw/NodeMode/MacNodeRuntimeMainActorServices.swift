import CoreLocation
import Foundation
import OpenClawKit

@MainActor
protocol MacNodeRuntimeMainActorServices: Sendable {
    func snapshotScreen(
        screenIndex: Int?,
        maxWidth: Int?,
        quality: Double?,
        format: OpenClawScreenSnapshotFormat?,
        desktopPermit: MacDesktopAvailabilityCoordinator.Permit) async throws
        -> ScreenSnapshotResult

    func recordScreen(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> (path: String, hasAudio: Bool)

    func locationAuthorizationStatus() -> CLAuthorizationStatus
    func locationAccuracyAuthorization() -> CLAccuracyAuthorization
    func currentLocation(
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation

    func performComputerAct(
        _ params: OpenClawComputerActParams,
        lifecycleGeneration: UInt64,
        desktopPermit: MacDesktopAvailabilityCoordinator.Permit) async throws -> OpenClawComputerActResult
    func releaseExecutionInput(_ permit: MacDesktopAvailabilityCoordinator.Permit) async
    func releaseHeldInput(lifecycleGeneration: UInt64) async
}

@MainActor
final class LiveMacNodeRuntimeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
    let desktopAvailability = MacDesktopAvailabilityCoordinator.shared
    private let screenSnapshotter = ScreenSnapshotService()
    private let screenRecorder = ScreenRecordService()
    private let locationService = MacNodeLocationService()
    private let computerAction = ComputerActionService()

    func snapshotScreen(
        screenIndex: Int?,
        maxWidth: Int?,
        quality: Double?,
        format: OpenClawScreenSnapshotFormat?,
        desktopPermit: MacDesktopAvailabilityCoordinator.Permit) async throws
        -> ScreenSnapshotResult
    {
        try self.desktopAvailability.validate(desktopPermit)
        let result = try await self.screenSnapshotter.snapshot(
            screenIndex: screenIndex,
            maxWidth: maxWidth,
            quality: quality,
            format: format)
        try self.desktopAvailability.validate(desktopPermit)
        return result
    }

    func recordScreen(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> (path: String, hasAudio: Bool)
    {
        try await self.screenRecorder.record(
            screenIndex: screenIndex,
            durationMs: durationMs,
            fps: fps,
            includeAudio: includeAudio,
            outPath: outPath)
    }

    func locationAuthorizationStatus() -> CLAuthorizationStatus {
        self.locationService.authorizationStatus()
    }

    func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
        self.locationService.accuracyAuthorization()
    }

    func currentLocation(
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    {
        try await self.locationService.currentLocation(
            desiredAccuracy: desiredAccuracy,
            maxAgeMs: maxAgeMs,
            timeoutMs: timeoutMs)
    }

    func performComputerAct(
        _ params: OpenClawComputerActParams,
        lifecycleGeneration: UInt64,
        desktopPermit: MacDesktopAvailabilityCoordinator.Permit) async throws -> OpenClawComputerActResult
    {
        try self.desktopAvailability.validate(desktopPermit)
        return try await self.computerAction.perform(
            params,
            lifecycleGeneration: lifecycleGeneration,
            inputScopeId: desktopPermit.inputScopeId,
            checkScopeAllowed: { try self.desktopAvailability.validate(desktopPermit) })
    }

    func releaseExecutionInput(_ permit: MacDesktopAvailabilityCoordinator.Permit) async {
        await self.computerAction.releaseHeldInput(inputScopeId: permit.inputScopeId)
    }

    func releaseHeldInput(lifecycleGeneration: UInt64) async {
        await self.computerAction.releaseHeldInput(lifecycleGeneration: lifecycleGeneration)
    }
}
