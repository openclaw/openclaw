import CoreLocation
import Foundation
import OpenClawIPC
import OpenClawKit

@MainActor
protocol MacNodeRuntimeMainActorServices: Sendable {
    func missingPermissions(_ capabilities: [Capability], disabled: [Capability]) async -> OpenClawNodeError?

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
        includeAudio: Bool?) async throws -> (path: String, durationMs: Int, fps: Double, hasAudio: Bool)

    func startSimulatorCapture(executionId: String) async throws -> SimulatorCaptureService.Frame
    func readSimulatorCapture(sessionId: String, after sequence: UInt64) async throws
        -> SimulatorCaptureService.Frame
    func stopSimulatorCapture(sessionId: String?) async
    func stopSimulatorCapture(forExecutionId executionId: String) async
    func simulatorInput(
        sessionId: String, action: OpenClawComputerAction,
        x: Double?, y: Double?, text: String?, keys: String?) async throws -> OpenClawComputerActParams
    func activateSimulator(sessionId: String, desktopPermit: MacDesktopAvailabilityCoordinator.Permit) throws

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
    private let simulatorCapture = SimulatorCaptureService()
    private let locationService = MacNodeLocationService()
    private let computerAction = ComputerActionService()

    func missingPermissions(_ capabilities: [Capability], disabled: [Capability]) async -> OpenClawNodeError? {
        await PermissionManager.missingPermissions(capabilities, disabled: disabled)
    }

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
        includeAudio: Bool?) async throws -> (path: String, durationMs: Int, fps: Double, hasAudio: Bool)
    {
        try await self.screenRecorder.record(
            screenIndex: screenIndex,
            durationMs: durationMs,
            fps: fps,
            includeAudio: includeAudio)
    }

    func startSimulatorCapture(executionId: String) async throws -> SimulatorCaptureService.Frame {
        try await self.simulatorCapture.start(executionId: executionId)
    }

    func readSimulatorCapture(sessionId: String, after sequence: UInt64) async throws
        -> SimulatorCaptureService.Frame
    {
        try await self.simulatorCapture.read(sessionId: sessionId, after: sequence)
    }

    func stopSimulatorCapture(sessionId: String?) async {
        await self.simulatorCapture.stop(sessionId: sessionId)
    }

    func stopSimulatorCapture(forExecutionId executionId: String) async {
        await self.simulatorCapture.stop(forExecutionId: executionId)
    }

    func simulatorInput(
        sessionId: String, action: OpenClawComputerAction,
        x: Double?, y: Double?, text: String?, keys: String?) async throws -> OpenClawComputerActParams
    {
        try await self.simulatorCapture.input(
            sessionId: sessionId, action: action, x: x, y: y, text: text, keys: keys)
    }

    func activateSimulator(sessionId: String, desktopPermit: MacDesktopAvailabilityCoordinator.Permit) throws {
        try self.desktopAvailability.validate(desktopPermit)
        try self.simulatorCapture.activate(sessionId: sessionId)
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
