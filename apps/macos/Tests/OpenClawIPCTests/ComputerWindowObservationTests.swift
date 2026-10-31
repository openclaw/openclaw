import CoreGraphics
import Darwin
import Foundation
import OpenClawKit
import PeekabooAutomationKit
import PeekabooFoundation
import Testing
@testable import OpenClaw

@MainActor
struct ComputerWindowObservationTests {
    @Test func `window executor refuses its own process before observing or focusing`() async {
        let service = ComputerWindowActionExecutor()
        service.adoptLifecycleGeneration(0)
        let ref = service.issueWindowRef(
            app: ServiceApplicationInfo(
                processIdentifier: getpid(),
                bundleIdentifier: "ai.openclaw.mac",
                name: "OpenClaw",
                windowCount: 1),
            window: ServiceWindowInfo(windowID: 77, title: "Chat", bounds: .zero))

        for action in [OpenClawComputerAction.getWindowState, .bringToFront, .getAccessibilityTree] {
            do {
                _ = try await service.perform(
                    OpenClawComputerActParams(action: action, windowRef: ref),
                    lifecycleGeneration: 0,
                    checkExecutionAllowed: {})
                Issue.record("Expected same-process refusal for \(action)")
            } catch {
                #expect(error.localizedDescription.contains("Peekaboo cannot inspect OpenClaw's own windows"))
            }
        }
    }

    @Test func `window executor rejects screenshot omission before capture`() async {
        let service = ComputerWindowActionExecutor()
        do {
            _ = try await service.perform(
                OpenClawComputerActParams(action: .getWindowState, windowRef: "window-1", includeScreenshot: false),
                lifecycleGeneration: 0,
                checkExecutionAllowed: {})
            Issue.record("Expected unsupported screenshot omission")
        } catch {
            #expect(error.localizedDescription.contains("includeScreenshot:false is unsupported by Peekaboo"))
        }
    }

    @Test func `window state publishes an owned snapshot of the observed window`() async throws {
        let directory = try Self.makeDirectory()
        defer { WindowObservationArtifacts.removeAll(in: directory) }
        let fixture = ObservedWindowFixture()
        let snapshots = InMemorySnapshotManager(options: ComputerWindowActionExecutor.snapshotManagerOptions)
        let applications = ApplicationService()
        let executor = ComputerWindowActionExecutor(
            automation: UIAutomationService(snapshotManager: snapshots),
            applications: applications,
            menu: MenuService(applicationService: applications),
            observationService: fixture.observationService(snapshotManager: snapshots),
            artifactDirectory: directory)
        executor.adoptLifecycleGeneration(1)
        let windowRef = executor.issueWindowRef(app: fixture.app, window: fixture.window)

        let result = try await executor.perform(
            OpenClawComputerActParams(action: .getWindowState, windowRef: windowRef),
            lifecycleGeneration: 1,
            checkExecutionAllowed: {})

        #expect(result.observation?.observationId != nil)
        #expect(result.observation?.elements?.map(\.label) == ["Save"])
        let snapshotID = try #require(await snapshots.getMostRecentSnapshot())
        #expect(SnapshotReference(rawValue: snapshotID) != nil)
        #expect(fixture.automation.lastSnapshotID == snapshotID)
        let stored = try await snapshots.getUIAutomationSnapshot(snapshotId: snapshotID)
        let capturePath = try #require(stored?.screenshotPath)
        #expect(capturePath.hasPrefix(directory.path + "/"))
    }

    @Test func `owned window snapshot publishes its capture and deletes it on cleanup`() async throws {
        let directory = try Self.makeDirectory()
        defer { WindowObservationArtifacts.removeAll(in: directory) }
        let manager = InMemorySnapshotManager(options: ComputerWindowActionExecutor.snapshotManagerOptions)
        let snapshotID = try await manager.createSnapshot(pendingAt: Date())

        let write = try await ObservationOutputWriter(snapshotManager: manager).write(
            capture: Self.capture(),
            elements: nil,
            options: DesktopObservationOutputOptions(
                path: directory.path + "/",
                saveSnapshot: true,
                snapshotID: snapshotID))

        let capturePath = try #require(write.files.rawScreenshotPath)
        #expect(write.files.publishedSnapshotID == snapshotID)
        #expect(capturePath.hasPrefix(directory.path + "/"))
        let stored = try await manager.getUIAutomationSnapshot(snapshotId: snapshotID)
        #expect(stored?.screenshotPath == capturePath)

        try await manager.cleanSnapshot(snapshotId: snapshotID)
        #expect(!FileManager.default.fileExists(atPath: capturePath))
    }

    @Test func `failed observation sweep removes only captures written since it started`() async throws {
        let directory = try Self.makeDirectory()
        defer { WindowObservationArtifacts.removeAll(in: directory) }
        let earlier = directory.appendingPathComponent("earlier.png")
        try Data([0x89, 0x50]).write(to: earlier)
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSinceNow: -60)],
            ofItemAtPath: earlier.path)

        let startedAt = Date()
        // The writer persists the capture before publication; without a snapshot
        // it stays unregistered, the shape a failed observation leaves behind.
        let write = try await ObservationOutputWriter().write(
            capture: Self.capture(),
            elements: nil,
            options: DesktopObservationOutputOptions(path: directory.path + "/", saveRawScreenshot: true))
        let orphan = try #require(write.files.rawScreenshotPath)

        WindowObservationArtifacts.discardArtifacts(writtenSince: startedAt, in: directory)

        #expect(!FileManager.default.fileExists(atPath: orphan))
        #expect(FileManager.default.fileExists(atPath: earlier.path))
    }

    @Test func `interrupted runs lose their captures while running processes keep theirs`() throws {
        let root = try Self.makeDirectory()
        defer { WindowObservationArtifacts.removeAll(in: root) }
        // PID 1 always runs; macOS never assigns a PID above 99998.
        for name in ["\(getpid())", "1", "999999", "not-a-pid"] {
            let directory = root.appendingPathComponent(name, isDirectory: true)
            try WindowObservationArtifacts.createPrivateDirectory(directory)
            try Data([0x89, 0x50]).write(to: directory.appendingPathComponent("capture.png"))
        }

        WindowObservationArtifacts.removeInterruptedRuns(in: root)

        let remaining = try FileManager.default.contentsOfDirectory(atPath: root.path).sorted()
        #expect(remaining == ["\(getpid())", "1"].sorted())
    }

    @Test func `capture directories are private to the user`() throws {
        let root = try Self.makeDirectory()
        defer { WindowObservationArtifacts.removeAll(in: root) }
        let parent = root.appendingPathComponent("\(getpid())", isDirectory: true)
        let directory = parent.appendingPathComponent("executor", isDirectory: true)

        try WindowObservationArtifacts.createPrivateDirectory(directory)

        for url in [parent, directory] {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        }
    }

    private static func makeDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-window-observation-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private static func capture() -> CaptureResult {
        CaptureResult(
            imageData: Data([0x89, 0x50, 0x4E, 0x47]),
            metadata: CaptureMetadata(size: CGSize(width: 4, height: 4), mode: .window))
    }
}

/// One exact window whose capture and accessibility detection are faked below
/// the real `DesktopObservationService`, so `get_window_state` runs through the
/// executor, Peekaboo's observation pipeline, and the snapshot manager.
@MainActor
private struct ObservedWindowFixture {
    let app = ServiceApplicationInfo(
        processIdentifier: 4321,
        processStartIdentity: 90210,
        bundleIdentifier: "com.example.observed",
        name: "Observed",
        windowCount: 1)
    let window: ServiceWindowInfo
    let identity: WindowMutationIdentity
    let automation = DetectingUIAutomation()

    init() {
        let bounds = CGRect(x: 100, y: 100, width: 400, height: 300)
        self.identity = WindowMutationIdentity(
            windowID: 77,
            ownerProcessIdentifier: 4321,
            ownerProcessStartIdentity: 90210,
            capturedBounds: bounds)
        self.window = ServiceWindowInfo(
            windowID: 77,
            title: "Observed Window",
            bounds: bounds,
            windowLevel: 0,
            alpha: 1,
            layer: 0,
            isOnScreen: true,
            sharingState: .readOnly,
            mutationIdentity: self.identity)
    }

    func observationService(snapshotManager: InMemorySnapshotManager) -> DesktopObservationService {
        let identity = self.identity
        return DesktopObservationService(
            screenCapture: WindowCapture(result: CaptureResult(
                imageData: Data([0x89, 0x50, 0x4E, 0x47]),
                metadata: CaptureMetadata(
                    size: self.window.bounds.size,
                    mode: .window,
                    applicationInfo: self.app,
                    windowInfo: self.window))),
            automation: self.automation,
            applications: FixedApplications(app: self.app, window: self.window),
            snapshotManager: snapshotManager,
            exactWindowMetadataProvider: ExactWindowMetadata(window: self.window),
            processStartIdentityProvider: { _ in identity.ownerProcessStartIdentity },
            windowMutationIdentityProvider: { _ in identity })
    }
}

private struct ExactWindowMetadata: ExactWindowMetadataProviding {
    let window: ServiceWindowInfo

    func metadata(for windowID: CGWindowID) -> ExactWindowObservationMetadata? {
        guard Int(windowID) == self.window.windowID else { return nil }
        return ExactWindowObservationMetadata(
            ownerProcessIdentifier: 4321,
            ownerProcessStartIdentity: 90210,
            title: self.window.title,
            bounds: self.window.bounds,
            applicationName: "Observed")
    }

    func processStartIdentity(for _: Int32) -> UInt64? {
        90210
    }
}

@MainActor
private final class FixedApplications: ApplicationServiceProtocol {
    let app: ServiceApplicationInfo
    let window: ServiceWindowInfo

    init(app: ServiceApplicationInfo, window: ServiceWindowInfo) {
        self.app = app
        self.window = window
    }

    func listApplications() async throws -> UnifiedToolOutput<ServiceApplicationListData> {
        UnifiedToolOutput(
            data: ServiceApplicationListData(applications: [self.app]),
            summary: .init(brief: "apps", status: .success),
            metadata: .init(duration: 0))
    }

    func findApplication(identifier _: String) async throws -> ServiceApplicationInfo {
        self.app
    }

    func listWindows(for _: String, timeout _: Float?) async throws -> UnifiedToolOutput<ServiceWindowListData> {
        UnifiedToolOutput(
            data: ServiceWindowListData(windows: [self.window], targetApplication: self.app),
            summary: .init(brief: "windows", status: .success),
            metadata: .init(duration: 0))
    }

    func getFrontmostApplication() async throws -> ServiceApplicationInfo {
        self.app
    }

    func isApplicationRunning(identifier _: String) async -> Bool {
        true
    }

    func launchApplication(identifier _: String) async throws -> ServiceApplicationInfo {
        self.app
    }

    func activateApplication(identifier _: String) async throws {}
    func quitApplication(identifier _: String, force _: Bool) async throws -> Bool {
        true
    }

    func hideApplication(identifier _: String) async throws {}
    func unhideApplication(identifier _: String) async throws {}
    func hideOtherApplications(identifier _: String) async throws {}
    func showAllApplications() async throws {}
}

@MainActor
private final class WindowCapture: ScreenCaptureServiceProtocol {
    let result: CaptureResult
    let captureTransactionGateOwner: CaptureTransactionGateOwner = .caller

    init(result: CaptureResult) {
        self.result = result
    }

    func captureScreen(
        displayIndex _: Int?,
        visualizerMode _: CaptureVisualizerMode,
        scale _: CaptureScalePreference) async throws -> CaptureResult
    {
        self.result
    }

    func captureWindow(
        appIdentifier _: String,
        windowIndex _: Int?,
        visualizerMode _: CaptureVisualizerMode,
        scale _: CaptureScalePreference) async throws -> CaptureResult
    {
        self.result
    }

    func captureWindow(
        windowID _: CGWindowID,
        visualizerMode _: CaptureVisualizerMode,
        scale _: CaptureScalePreference) async throws -> CaptureResult
    {
        self.result
    }

    func captureFrontmost(
        visualizerMode _: CaptureVisualizerMode,
        scale _: CaptureScalePreference) async throws -> CaptureResult
    {
        self.result
    }

    func captureArea(
        _: CGRect,
        visualizerMode _: CaptureVisualizerMode,
        scale _: CaptureScalePreference) async throws -> CaptureResult
    {
        self.result
    }

    func hasScreenRecordingPermission() async -> Bool {
        true
    }
}

/// Returns one button under whatever snapshot id the observation hands it,
/// like the accessibility detector does.
@MainActor
private final class DetectingUIAutomation: UIAutomationServiceProtocol {
    private(set) var lastSnapshotID: String?

    func detectElements(
        in _: Data,
        snapshotId: String?,
        windowContext _: WindowContext?) async throws -> ElementDetectionResult
    {
        self.lastSnapshotID = snapshotId
        let elements = DetectedElements(buttons: [DetectedElement(
            id: "B1",
            type: .button,
            label: "Save",
            bounds: CGRect(x: 120, y: 130, width: 40, height: 20),
            isEnabled: true)])
        return ElementDetectionResult(
            snapshotId: snapshotId ?? UUID().uuidString,
            screenshotPath: "",
            elements: elements,
            metadata: DetectionMetadata(detectionTime: 0, elementCount: elements.all.count, method: "fixture"))
    }

    func click(target _: ClickTarget, clickType _: ClickType, snapshotId _: String?) async throws {}
    func type(
        text _: String,
        target _: String?,
        clearExisting _: Bool,
        typingDelay _: Int,
        snapshotId _: String?) async throws {}
    func typeActions(_: [TypeAction], cadence _: TypingCadence, snapshotId _: String?) async throws -> TypeResult {
        TypeResult(totalCharacters: 0, keyPresses: 0)
    }

    func scroll(_: ScrollRequest) async throws {}
    func hotkey(keys _: String, holdDuration _: Int) async throws {}
    func swipe(
        from _: CGPoint,
        to _: CGPoint,
        duration _: Int,
        steps _: Int,
        profile _: MouseMovementProfile) async throws {}
    func hasAccessibilityPermission() async -> Bool {
        true
    }

    func waitForElement(target _: ClickTarget, timeout _: TimeInterval, snapshotId _: String?) async throws
        -> WaitForElementResult
    {
        WaitForElementResult(found: false, element: nil, waitTime: 0)
    }

    func drag(_: DragOperationRequest) async throws {}
    func moveMouse(to _: CGPoint, duration _: Int, steps _: Int, profile _: MouseMovementProfile) async throws {}
    func getFocusedElement() -> UIFocusInfo? {
        nil
    }

    func findElement(matching _: UIElementSearchCriteria, in _: String?) async throws -> DetectedElement {
        throw CancellationError()
    }
}
