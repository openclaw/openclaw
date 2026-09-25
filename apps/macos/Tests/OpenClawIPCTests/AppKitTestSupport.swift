import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Testing

@MainActor
enum AppKitTestSupport {
    /// Rendered suites share one process and must initialize AppKit only once.
    private static let initializedApplication: (application: NSApplication, didSetActivationPolicy: Bool) = {
        let application = NSApplication.shared
        let didSetActivationPolicy = application.setActivationPolicy(.accessory)
        #expect(didSetActivationPolicy)
        application.finishLaunching()
        return (application, didSetActivationPolicy)
    }()

    static var application: NSApplication {
        self.initializedApplication.application
    }

    static var didSetActivationPolicy: Bool {
        self.initializedApplication.didSetActivationPolicy
    }

    static func startApplication() async throws {
        let application = self.application
        guard !application.isRunning else { return }
        await withCheckedContinuation { continuation in
            // Start outside a Swift task so AppKit owns nested menu run loops.
            // Otherwise macOS 27 can stop Swift's outer loop and exit before test completion.
            RunLoop.main.perform(inModes: [.common]) {
                MainActor.assumeIsolated {
                    let started = Timer(timeInterval: 0, repeats: false) { _ in
                        continuation.resume()
                    }
                    RunLoop.main.add(started, forMode: .common)
                    application.run()
                }
            }
        }
        try #require(application.isRunning)
    }

    static func pointAtModelButton(_ button: AnyObject, in window: NSWindow) throws {
        try #require((button.accessibilityWindow?() as? NSWindow) === window)
        try #require(button.accessibilityLabel?() == "Model" && button.isAccessibilityEnabled?() == true)
        let frame = try #require(button.accessibilityFrame?())
        try #require(!frame.isEmpty && window.frame.contains(frame))
        // The native menu anchors at NSEvent.mouseLocation even when opened through accessibility.
        let primaryScreen = try #require(NSScreen.screens.first)
        let position = CGPoint(x: frame.midX, y: primaryScreen.frame.maxY - frame.midY)
        try #require(CGWarpMouseCursorPosition(position) == .success)
    }

    static func accessibilityElements(
        in root: AnyObject,
        diagnosticContext: String? = nil) async throws -> [AnyObject]
    {
        let before = diagnosticContext.map { _ in self.accessibilityDiagnosticState(in: root) }
        // SwiftUI materializes its virtual accessibility children after a real client request.
        let result = await Task.detached {
            let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
            var windows: CFTypeRef?
            return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows)
        }.value
        let after = diagnosticContext.map { _ in self.accessibilityDiagnosticState(in: root) }
        try #require(result == .success, diagnosticContext.map {
            Comment(rawValue: "\($0) before=[\(before ?? "")] after=[\(after ?? "")]")
        })
        var elements: [AnyObject] = []
        var visited = Set<ObjectIdentifier>()
        func visit(_ element: AnyObject) {
            guard visited.insert(ObjectIdentifier(element)).inserted else { return }
            elements.append(element)
            for child in element.accessibilityChildren?() ?? [] {
                visit(child as AnyObject)
            }
        }
        visit(root)
        return elements
    }

    private static func accessibilityDiagnosticState(in root: AnyObject) -> String {
        // Observe existing AppKit state without initializing it or retaining a window across the AX request.
        let application = NSApp.map {
            "appExists=true isRunning=\($0.isRunning) isActive=\($0.isActive) activationPolicy=\($0.activationPolicy().rawValue)"
        } ?? "appExists=false"
        let window = (root as? NSWindow) ?? (root as? NSView)?.window
        return "\(application) rootWindowAttached=\(window != nil) rootWindowVisible=\(window?.isVisible == true)"
    }

    static func accessibilityTitle(of element: AnyObject) -> String? {
        // SwiftUI menu titles may be attributed strings; the typed String getter raises an ObjC exception.
        let selector = NSSelectorFromString("accessibilityTitle")
        guard let object = element as? NSObject, object.responds(to: selector),
              let value = object.perform(selector)?.takeUnretainedValue() else { return nil }
        if let attributed = value as? NSAttributedString { return attributed.string }
        return value as? String
    }

    static func accessibilityName(of element: AnyObject) -> String? {
        if let label = element.accessibilityLabel?(), !label.isEmpty { return label }
        return self.accessibilityTitle(of: element)
    }

    static func waitForAccessibilityElement(
        in window: NSWindow,
        description: String,
        matching find: ([AnyObject]) -> AnyObject?) async throws -> AnyObject
    {
        let deadline = ContinuousClock.now + .seconds(3)
        var observedElements: [AnyObject] = []
        repeat {
            window.contentView?.layoutSubtreeIfNeeded()
            let elements = try await self.accessibilityElements(in: window)
            observedElements = elements
            if let element = find(elements) {
                return element
            }
            try await Task.sleep(for: .milliseconds(20))
        } while ContinuousClock.now < deadline
        let toolbarItems: String = (window.toolbar?.items ?? []).map {
            "\($0.itemIdentifier.rawValue): view=\(String(describing: $0.view))"
        }.joined(separator: "\n")
        let accessibility: String = observedElements.map {
            let role = String(describing: $0.accessibilityRole?())
            let title = String(describing: self.accessibilityTitle(of: $0))
            let label = String(describing: $0.accessibilityLabel?())
            let value: Any? = $0.accessibilityValue?()
            let identifier = String(describing: $0.accessibilityIdentifier?())
            return "role=\(role) title=\(title) label=\(label) value=\(String(describing: value)) identifier=\(identifier)"
        }.joined(separator: "\n")
        throw InteractionFailure(message: """
        The rendered window must expose \(description)
        appActive=\(NSApp.isActive) windowVisible=\(window.isVisible) windowKey=\(window.isKeyWindow)
        Toolbar items:
        \(toolbarItems)
        Accessibility elements:
        \(accessibility)
        """)
    }

    static func openMenu(
        _ button: AnyObject,
        in window: NSWindow,
        waitForDismissal: Bool = false,
        requireCompositedPopup: Bool = false,
        file: StaticString = #fileID,
        line: UInt = #line,
        inspect: @escaping (NSMenu) throws -> Void) async throws
    {
        let role: NSAccessibility.Role? = button.accessibilityRole?()
        let controlType = String(reflecting: type(of: button))
        let tracking = AppKitTestMenuTracking(
            waitForDismissal: waitForDismissal,
            requireCompositedPopup: requireCompositedPopup,
            inspect: inspect)
        tracking.start()
        defer { tracking.stop() }
        try Task.checkCancellation()
        func text(_ value: String?) -> String {
            value.map { String($0.prefix(160)) } ?? "nil"
        }
        let value: Any? = button.accessibilityValue?()
        let valueText = (value as? String) ?? (value as? NSNumber)?.stringValue ??
            value.map { String(reflecting: type(of: $0)) }
        let enabled: Bool? = button.isAccessibilityEnabled?()
        let frame: NSRect? = button.accessibilityFrame?()
        let windowMatches = (button.accessibilityWindow?() as? NSWindow) === window
        let pressAllowed = button.isAccessibilitySelectorAllowed?(NSSelectorFromString("accessibilityPerformPress"))
        let showMenuAllowed = button.isAccessibilitySelectorAllowed?(
            NSSelectorFromString("accessibilityPerformShowMenu"))
        print("""
        Before menu dispatch at \(file):\(line)
        node=\(ObjectIdentifier(button)) type=\(text(controlType)) role=\(String(describing: role))
        identifier=\(text(button.accessibilityIdentifier?())) title=\(text(self.accessibilityTitle(of: button))) label=\(text(button.accessibilityLabel?())) value=\(text(valueText))
        enabled=\(String(describing: enabled)) frame=\(String(describing: frame)) window=\(window.windowNumber) windowMatches=\(windowMatches)
        pressAllowed=\(String(describing: pressAllowed)) showMenuAllowed=\(String(describing: showMenuAllowed)) remaining=\(ContinuousClock.now.duration(to: tracking.expiresAt)) appRunning=\(NSApp.isRunning)
        """)
        let performAction: @MainActor () throws -> (String, String?, Bool?) = {
            guard ContinuousClock.now < tracking.expiresAt else {
                throw InteractionFailure(message: "The menu interaction deadline expired before dispatch")
            }
            let action: String
            var ownerType: String?
            var actionResult: Bool?
            if let cell = button as? NSPopUpButtonCell {
                guard let owner = cell.controlView as? NSPopUpButton,
                      owner.cell === cell,
                      owner.window === window,
                      owner.isEnabled
                else {
                    throw InteractionFailure(message:
                        "The popup cell must belong to its enabled fixture control and window: \(controlType), owner=\(String(describing: cell.controlView))")
                }
                action = "popup-cell"
                ownerType = String(reflecting: type(of: owner))
                cell.performClick(withFrame: owner.bounds, in: owner)
            } else {
                let windowMatches = (button.accessibilityWindow?() as? NSWindow) === window
                guard role == .button || role == .menuButton,
                      windowMatches
                else {
                    throw InteractionFailure(message:
                        "Unsupported menu element or fixture window: \(controlType), role=\(String(describing: role)), windowMatches=\(windowMatches)")
                }
                if pressAllowed == true {
                    action = "accessibility-press"
                    actionResult = button.accessibilityPerformPress?()
                } else if showMenuAllowed == true {
                    action = "accessibility-show-menu"
                    actionResult = button.accessibilityPerformShowMenu?()
                } else {
                    throw InteractionFailure(message:
                        "The fixture menu element has no allowed accessibility action: Press=\(String(describing: pressAllowed)), ShowMenu=\(String(describing: showMenuAllowed))")
                }
                guard actionResult != nil else {
                    throw InteractionFailure(
                        message: "The fixture menu element does not implement its allowed \(action) action")
                }
            }
            return (action, ownerType, actionResult)
        }
        // AX actions enter NSMenu's nested loop synchronously. Suspend this task first so
        // Gateway delivery and model-owned dismissal can use the main actor during tracking.
        let outcome: (action: String, ownerType: String?, result: Bool?) = try await withCheckedThrowingContinuation {
            continuation in
            RunLoop.main.perform(inModes: [.common]) {
                MainActor.assumeIsolated {
                    do { continuation.resume(returning: try performAction()) }
                    catch { continuation.resume(throwing: error) }
                }
            }
            CFRunLoopWakeUp(CFRunLoopGetMain())
        }
        await tracking.waitForCompletion()
        let completed = tracking.observed && tracking.completed && !tracking.timedOut
        print("""
        Menu interaction at \(file):\(line)
        action=\(outcome.action) result=\(String(describing: outcome.result))
        observed=\(tracking.observed) inspected=\(tracking.inspectionCompleted) timedOut=\(tracking.timedOut) error=\(String(describing: tracking.error))
        control=\(controlType) owner=\(String(describing: outcome.ownerType)) role=\(String(describing: role)) appActive=\(NSApp.isActive) visible=\(window.isVisible) key=\(window.isKeyWindow)
        """)
        if let error = tracking.error { throw error }
        try Task.checkCancellation()
        // Ordinary inspections cancel tracking; lifecycle proofs wait for the owning menu to close itself.
        guard completed else {
            throw InteractionFailure(message: "The native menu inspection must complete before its tracking deadline")
        }
    }

    static func recordCompositedWindow(
        _ window: NSWindow, name: String, directory: URL) async throws
    {
        try await Task.sleep(for: .milliseconds(300))
        let screen = try #require(window.screen)
        let acknowledgement = "\(name)-\(UUID().uuidString).captured"
        let frame = window.frame
        let bounds = screen.frame
        // Native materials and custom menu labels need the compositor, not NSView.cacheDisplay.
        let request: [String: Any] = [
            "windowID": window.windowNumber,
            "window": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height],
            "screen": ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height],
            "acknowledgement": acknowledgement,
        ]
        try JSONSerialization.data(withJSONObject: request, options: [.sortedKeys])
            .write(to: directory.appendingPathComponent("\(name)-capture-request.json"), options: .atomic)
        let deadline = ContinuousClock.now + .seconds(30)
        let acknowledged = directory.appendingPathComponent(acknowledgement).path
        while !FileManager.default.fileExists(atPath: acknowledged), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        try #require(FileManager.default.fileExists(atPath: acknowledged), "The external screenshot must complete")
    }

    static func record(menu: NSMenu, content: NSView?, name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["OPENCLAW_TEST_MENU_CAPTURE_DIR"] else {
            throw InteractionFailure(message: "Menu capture requires the native launcher's capture directory")
        }
        let output = URL(fileURLWithPath: directory, isDirectory: true)
        var blockers: [String] = []
        var pngs: [String] = []
        func items(_ menu: NSMenu) -> [[String: Any]] {
            menu.items.map { item in
                var row: [String: Any] = [
                    "title": item.title, "enabled": item.isEnabled, "selected": item.state == .on,
                ]
                if let submenu = item.submenu { row["children"] = items(submenu) }
                return row
            }
        }
        func capture(_ view: NSView?, filename: String) throws {
            guard let view, !view.bounds.isEmpty,
                  let image = view.bitmapImageRepForCachingDisplay(in: view.bounds)
            else {
                throw InteractionFailure(message: "No cacheable view for \(filename)")
            }
            view.cacheDisplay(in: view.bounds, to: image)
            guard let data = image.representation(using: .png, properties: [:]), !data.isEmpty else {
                throw InteractionFailure(message: "No PNG representation for \(filename)")
            }
            try data.write(to: output.appendingPathComponent(filename))
            pngs.append(filename)
        }
        let windowContent = content?.window?.contentView
        var frameError: Error?
        do {
            try capture(windowContent?.superview ?? windowContent, filename: "\(name)-window.png")
        } catch {
            frameError = error
            blockers.append("Required frame capture failed: \(error.localizedDescription)")
        }
        var menuWindowCount = 0
        if let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], 0) as? [[String: Any]]
        {
            for window in windows
                where window[kCGWindowOwnerPID as String] as? Int32 == ProcessInfo.processInfo.processIdentifier
            {
                guard window[kCGWindowLayer as String] as? Int == NSWindow.Level.popUpMenu.rawValue,
                      let number = window[kCGWindowNumber as String] as? UInt32 else { continue }
                menuWindowCount += 1
                let popupContent = NSApp.window(withWindowNumber: Int(number))?.contentView
                do {
                    try capture(popupContent?.superview ?? popupContent, filename: "\(name)-menu-\(number).png")
                } catch {
                    blockers.append("Popup \(number) capture unavailable: \(error.localizedDescription)")
                }
            }
        }
        if menuWindowCount == 0 {
            blockers.append("No owned popup window was listed")
        }
        let status: [String: Any] = [
            "name": name,
            "method": "NSView.cacheDisplay",
            "menu": items(menu),
            "menuWindowCount": menuWindowCount,
            "pngs": pngs,
            "blockers": blockers,
            "requiresVisualInspection": true,
        ]
        if !blockers.isEmpty {
            print("Menu capture blocked for \(name): \(blockers.joined(separator: "; "))")
        }
        try JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("\(name)-capture-status.json"))
        if let frameError { throw frameError }
    }

    private struct InteractionFailure: LocalizedError {
        let message: String
        var errorDescription: String? {
            self.message
        }
    }
}

@MainActor
private final class AppKitTestMenuTracking: NSObject {
    private static let timeout: TimeInterval = 3
    let inspect: (NSMenu) throws -> Void
    let expiresAt: ContinuousClock.Instant
    let waitForDismissal: Bool
    let requireCompositedPopup: Bool
    private(set) var observed = false
    private(set) var inspectionCompleted = false
    private(set) var timedOut = false
    private(set) var error: Error?
    private var dismissalObserved = false
    private var inspectionStarted = false
    private var menu: NSMenu?
    private var inspection: Timer?
    private var deadline: Timer?
    private var completion: CheckedContinuation<Void, Never>?

    var completed: Bool {
        self.inspectionCompleted && (!self.waitForDismissal || self.dismissalObserved)
    }

    init(
        waitForDismissal: Bool,
        requireCompositedPopup: Bool,
        inspect: @escaping (NSMenu) throws -> Void)
    {
        self.inspect = inspect
        self.waitForDismissal = waitForDismissal
        self.requireCompositedPopup = requireCompositedPopup
        self.expiresAt = ContinuousClock.now + .seconds(Self.timeout)
    }

    func start() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(self.beganTracking(_:)),
            name: NSMenu.didBeginTrackingNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(self.endedTracking(_:)),
            name: NSMenu.didEndTrackingNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(self.applicationUpdated(_:)),
            name: NSApplication.didUpdateNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(self.applicationUpdated(_:)),
            name: NSWindow.didUpdateNotification, object: nil)
        let deadline = Timer(
            timeInterval: Self.timeout,
            target: self,
            selector: #selector(self.expire),
            userInfo: nil,
            repeats: false)
        self.deadline = deadline
        for mode in [RunLoop.Mode.eventTracking, .common] {
            RunLoop.main.add(deadline, forMode: mode)
        }
    }

    func waitForCompletion() async {
        guard !self.completed, !self.timedOut, self.error == nil else { return }
        await withCheckedContinuation { self.completion = $0 }
    }

    @objc private func beganTracking(_ notification: Notification) {
        guard !self.observed, let menu = notification.object as? NSMenu else { return }
        self.observed = true
        self.menu = menu
        guard !self.timedOut, ContinuousClock.now < self.expiresAt else {
            self.expire()
            return
        }
        // AppKit tracks menus in a nested run loop; inspect and cancel in that mode too.
        let inspection = Timer(
            timeInterval: self.requireCompositedPopup ? 0.02 : 0,
            target: self,
            selector: #selector(self.inspectMenu),
            userInfo: nil,
            repeats: self.requireCompositedPopup)
        self.inspection = inspection
        for mode in [RunLoop.Mode.eventTracking, .common] {
            RunLoop.main.add(inspection, forMode: mode)
        }
    }

    @objc private func endedTracking(_ notification: Notification) {
        guard let menu = notification.object as? NSMenu, self.menu === menu else { return }
        self.menu = nil
        self.dismissalObserved = true
        if self.completed {
            self.deadline?.invalidate()
            self.resumeWaiter()
        }
    }

    @objc private func applicationUpdated(_: Notification) {
        self.inspectMenu()
    }

    @objc private func inspectMenu() {
        guard !self.inspectionStarted, let menu = self.menu else { return }
        guard !self.timedOut, ContinuousClock.now < self.expiresAt else {
            self.expire()
            return
        }
        guard NSApp.windows.contains(where: { $0.level == .popUpMenu && $0.isVisible }) else { return }
        if self.requireCompositedPopup {
            // Window Server publication can follow the last AppKit update; retry within the same menu deadline.
            let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0)
                as? [[String: Any]] ?? []
            guard windows.contains(where: { window in
                guard window[kCGWindowOwnerPID as String] as? Int32 == ProcessInfo.processInfo.processIdentifier,
                      window[kCGWindowLayer as String] as? Int == NSWindow.Level.popUpMenu.rawValue,
                      let fields = window[kCGWindowBounds as String] as? [String: Any],
                      let bounds = CGRect(dictionaryRepresentation: fields as CFDictionary)
                else { return false }
                return !bounds.isEmpty
            }) else { return }
        }
        self.inspectionStarted = true
        self.inspection?.invalidate()
        defer {
            self.inspectionCompleted = true
            if !self.waitForDismissal || self.error != nil {
                self.deadline?.invalidate()
                self.cancelTracking()
                self.resumeWaiter()
            } else if self.dismissalObserved {
                self.deadline?.invalidate()
                self.resumeWaiter()
            }
        }
        do { try self.inspect(menu) } catch { self.error = error }
    }

    @objc private func expire() {
        guard !self.completed else { return }
        self.timedOut = true
        self.cancelTracking()
        self.resumeWaiter()
    }

    func stop() {
        self.inspection?.invalidate()
        self.deadline?.invalidate()
        self.cancelTracking()
        NotificationCenter.default.removeObserver(self)
        self.resumeWaiter()
    }

    private func cancelTracking() {
        let menu = self.menu
        self.menu = nil
        menu?.cancelTrackingWithoutAnimation()
    }

    private func resumeWaiter() {
        let completion = self.completion
        self.completion = nil
        completion?.resume()
    }
}
