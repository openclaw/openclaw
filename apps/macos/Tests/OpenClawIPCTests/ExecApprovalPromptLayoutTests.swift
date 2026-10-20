import AppKit
import OpenClawKit
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ExecApprovalPromptLayoutTests {
    @Test(arguments: [false, true])
    func `approval refusal settles only the requesting scope's held input`(sameScope: Bool) async throws {
        let owner = UUID()
        let approval = UUID()
        var posted: [Bool] = []
        let screen = ComputerScreenActionExecutor { down, _, _ in posted.append(down) }
        let service = ComputerActionService(screen: screen)
        try screen.pressLeftButton(at: .zero, flags: [.maskShift], inputScopeId: owner)
        defer {
            screen.releaseCurrentHeldButton()
            ApprovalPromptState.shared.setPending(false, source: approval)
        }
        ApprovalPromptState.shared.setPending(true, source: approval)

        do {
            _ = try await service.perform(
                OpenClawComputerActParams(action: .leftMouseUp),
                lifecycleGeneration: 0,
                inputScopeId: sameScope ? owner : UUID())
            Issue.record("Expected approval refusal")
        } catch let ComputerActionService.ComputerActionError.refused(message) {
            #expect(message == "A human approval prompt is open on this Mac; wait for the user to answer it")
        }

        #expect(screen.isLeftButtonDownForTesting == !sameScope)
        #expect(posted == (sameScope ? [true, false] : [true]))
    }

    @Test func `dashboard confirmation sheets refuse computer input until answered`() async throws {
        _ = AppKitTestSupport.application
        let document = try ControlUIDocumentHost(
            url: #require(URL(string: "https://gateway.example")),
            auth: .unauthenticated,
            websiteDataStore: .nonPersistent(),
            installCapabilities: { _ in })
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.titled],
            backing: .buffered,
            defer: false)
        window.isReleasedWhenClosed = false
        window.orderBack(nil)
        defer { window.close() }

        let accepted = await withCheckedContinuation { continuation in
            document.confirm(message: "Allow this action?", host: "gateway.example", parent: window) {
                continuation.resume(returning: $0)
            }
            #expect(ApprovalPromptState.shared.isPending)
            #expect(window.attachedSheet?.sharingType == NSWindow.SharingType.none)
            #expect(throws: ComputerActionService.ComputerActionError.self) {
                try ApprovalPromptState.shared.checkComputerAction(.key)
            }
            if let sheet = window.attachedSheet {
                window.endSheet(sheet, returnCode: .alertFirstButtonReturn)
            } else {
                window.close()
            }
        }
        #expect(accepted)
    }

    @Test func `pending approval refuses computer input before permissions or dispatch`() async throws {
        let reservation = try #require(ExecApprovalsPromptPresenter.reservePromptForTesting())
        defer { ExecApprovalsPromptPresenter.releasePromptForTesting(id: reservation) }

        for action in [OpenClawComputerAction.leftClick, .key, .setValue] {
            do {
                _ = try await ComputerActionService().perform(
                    OpenClawComputerActParams(action: action), lifecycleGeneration: 0)
                Issue.record("Expected human approval to refuse computer input")
            } catch let ComputerActionService.ComputerActionError.refused(message) {
                #expect(message == "A human approval prompt is open on this Mac; wait for the user to answer it")
            }
        }
    }

    @Test func `escape cancels fallback consent instead of choosing the final button`() throws {
        _ = AppKitTestSupport.application
        let presenter = DashboardAlertPresenter()
        defer { presenter.dismissAll() }
        let alert = NSAlert()
        alert.addButton(withTitle: "Cancel").keyEquivalent = "\r"
        alert.addButton(withTitle: "Allow").keyEquivalent = ""
        _ = alert.window
        let windows = Set(NSApp.windows.map(ObjectIdentifier.init))
        var response: NSApplication.ModalResponse?
        presenter.present(alert, over: nil) { response = $0 }
        let panel = try #require(NSApp.windows.first { !windows.contains(ObjectIdentifier($0)) && $0 is NSPanel })
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.makeFirstResponder(panel.contentView)
        let escape = try #require(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: panel.windowNumber,
            context: nil,
            characters: "\u{1B}",
            charactersIgnoringModifiers: "\u{1B}",
            isARepeat: false,
            keyCode: 53))
        if !panel.performKeyEquivalent(with: escape) {
            panel.sendEvent(escape)
        }
        #expect(response == .cancel)
        #expect(presenter._testPendingAlerts.isEmpty)
    }

    @Test func `closing one prompt does not enable input while another owner is pending`() throws {
        let state = ApprovalPromptState()
        let panel = UUID()
        let queue = UUID()
        state.setPending(true, source: panel)
        state.setPending(true, source: queue)
        state.setPending(false, source: panel)

        #expect(throws: ComputerActionService.ComputerActionError.self) { try state.checkComputerAction(.key) }
        try state.checkComputerAction(.listWindows)
        state.setPending(false, source: queue)
        try state.checkComputerAction(.key)
    }

    @Test func `screen capture with a pending approval requires an app exclusion`() throws {
        let state = ApprovalPromptState()
        try state.checkScreenCapture(excludesApplication: false)

        state.setPending(true, source: UUID())
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try state.checkScreenCapture(excludesApplication: false)
        }
        try state.checkScreenCapture(excludesApplication: true)
    }

    @Test func `queued prompt expires without later presentation`() async throws {
        let reservation = try #require(ExecApprovalsPromptPresenter.reservePromptForTesting())
        defer { ExecApprovalsPromptPresenter.releasePromptForTesting(id: reservation) }

        let decision = await ExecApprovalsPromptPresenter.prompt(
            ExecApprovalPromptRequest(command: "/usr/bin/printf ok"),
            timeoutMs: 1)

        #expect(decision == nil)
        #expect(ExecApprovalsPromptPresenter.pendingPromptCountForTesting == 0)
    }

    @Test func `active prompt expiry releases presentation for the next request`() async throws {
        for command in ["/usr/bin/printf first", "/usr/bin/printf second"] {
            let decision = await ExecApprovalsPromptPresenter.prompt(
                ExecApprovalPromptRequest(command: command),
                timeoutMs: 20)

            #expect(decision == nil)
            let reservation = try #require(ExecApprovalsPromptPresenter.reservePromptForTesting())
            ExecApprovalsPromptPresenter.releasePromptForTesting(id: reservation)
        }
    }

    @Test func `cancelling an active prompt releases presentation for the next request`() async throws {
        let prompt = Task {
            await ExecApprovalsPromptPresenter.prompt(
                ExecApprovalPromptRequest(command: "/usr/bin/printf cancelled"))
        }
        defer { prompt.cancel() }
        await Task.yield()
        try await Task.sleep(for: .milliseconds(20))
        prompt.cancel()

        #expect(await prompt.value == nil)
        let reservation = try #require(ExecApprovalsPromptPresenter.reservePromptForTesting())
        ExecApprovalsPromptPresenter.releasePromptForTesting(id: reservation)
        let nextDecision = await ExecApprovalsPromptPresenter.prompt(
            ExecApprovalPromptRequest(command: "/usr/bin/printf next"),
            timeoutMs: 20)
        #expect(nextDecision == nil)
    }

    @Test func `allowed decisions omit durable approval even when ask allows it`() {
        let decisions = ExecApprovalsPromptPresenter.allowedPromptDecisions(
            ExecApprovalPromptRequest(
                command: "/bin/sh -lc pwd",
                cwd: "/Users/example/projects/openclaw",
                host: "node",
                security: "full",
                ask: "on-miss",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1",
                allowedDecisions: [.allowOnce, .deny]))

        #expect(decisions == [.allowOnce, .deny])
    }

    @Test func `ask always prompts omit durable approval when decisions are omitted`() {
        let decisions = ExecApprovalsPromptPresenter.allowedPromptDecisions(
            ExecApprovalPromptRequest(
                command: "/bin/sh -lc pwd",
                cwd: "/Users/example/projects/openclaw",
                host: "node",
                security: "full",
                ask: "always",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1"))

        #expect(decisions == [.allowOnce, .deny])
    }

    @Test func `ask on miss prompts keep durable approval when decisions are omitted`() {
        let decisions = ExecApprovalsPromptPresenter.allowedPromptDecisions(
            ExecApprovalPromptRequest(
                command: "/bin/sh -lc pwd",
                cwd: "/Users/example/projects/openclaw",
                host: "node",
                security: "full",
                ask: "on-miss",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1"))

        #expect(decisions == [.allowOnce, .allowAlways, .deny])
    }

    @Test func `allow always is omitted when no safe persistence pattern exists`() {
        let decisions = ExecApprovalPromptRequest.allowedDecisions(
            forAsk: "on-miss",
            allowAlwaysEligible: false)

        #expect(decisions == [.allowOnce, .deny])
        #expect(ExecApprovalPromptRequest.allowedDecisions(forAsk: "on-miss").contains(.allowAlways))
    }

    @Test func `allow always eligibility requires allowlist policy and bound reusable execution`() {
        func evaluation(
            security: ExecSecurity,
            boundCommand: [String]?,
            patterns: [ExecAllowAlwaysPattern]) -> ExecApprovalEvaluation
        {
            ExecApprovalEvaluation(
                displayCommand: "/usr/bin/printf ok",
                agentId: "main",
                security: security,
                ask: .onMiss,
                askFallback: .deny,
                env: [:],
                resolution: nil,
                allowlistResolutions: [],
                boundCommand: boundCommand,
                allowAlwaysPatterns: patterns,
                allowlistMatches: [],
                allowlistAuthorizationSatisfied: false,
                allowlistMatch: nil,
                skillTrust: nil,
                policySnapshot: ExecApprovalPolicySnapshot(
                    security: security,
                    ask: .onMiss,
                    askFallback: .deny,
                    autoAllowSkills: false,
                    allowlist: []))
        }

        #expect(evaluation(
            security: .allowlist,
            boundCommand: ["/usr/bin/printf", "ok"],
            patterns: [ExecAllowAlwaysPattern(pattern: "/usr/bin/printf")]).canPersistAllowAlways)
        #expect(!evaluation(
            security: .full,
            boundCommand: ["/usr/bin/printf", "ok"],
            patterns: [ExecAllowAlwaysPattern(pattern: "/usr/bin/printf")]).canPersistAllowAlways)
        #expect(!evaluation(
            security: .allowlist,
            boundCommand: nil,
            patterns: [ExecAllowAlwaysPattern(pattern: "/usr/bin/printf")]).canPersistAllowAlways)
    }

    @Test func `legacy prompts keep durable approval when policy fields are omitted`() {
        let decisions = ExecApprovalsPromptPresenter.allowedPromptDecisions(
            ExecApprovalPromptRequest(
                command: "/bin/sh -lc pwd",
                cwd: "/Users/example/projects/openclaw",
                host: "node",
                security: "full",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1"))

        #expect(decisions == [.allowOnce, .allowAlways, .deny])
    }

    @Test func `unknown ask prompts keep legacy durable approval when decisions are omitted`() {
        let decisions = ExecApprovalsPromptPresenter.allowedPromptDecisions(
            ExecApprovalPromptRequest(
                command: "/bin/sh -lc pwd",
                cwd: "/Users/example/projects/openclaw",
                host: "node",
                security: "full",
                ask: "unexpected",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1"))

        #expect(decisions == [.allowOnce, .allowAlways, .deny])
    }

    @Test func `approval request decodes valid allowed decisions only`() throws {
        let data = Data(
            #"{"command":"/bin/sh -lc pwd","ask":"on-miss","allowedDecisions":["allow-once","bad","deny",3]}"#.utf8)

        let request = try JSONDecoder().decode(ExecApprovalPromptRequest.self, from: data)

        #expect(request.allowedDecisions == [.allowOnce, .deny])
    }

    @Test func `approval request falls back when allowed decisions has wrong shape`() throws {
        let data = Data(#"{"command":"/bin/sh -lc pwd","ask":"always","allowedDecisions":"allow-once"}"#.utf8)

        let request = try JSONDecoder().decode(ExecApprovalPromptRequest.self, from: data)

        #expect(ExecApprovalsPromptPresenter.allowedPromptDecisions(request) == [.allowOnce, .deny])
    }

    @Test func `long commands remain scrollable in a bounded approval panel`() throws {
        let command = String(repeating: "printf 'review this command'; ", count: 100) + "echo safe\u{202E}\nnext"
        let panel = ExecApprovalsPromptPresenter.buildPanel(
            ExecApprovalPromptRequest(
                command: command,
                cwd: "/Users/example/" + String(repeating: "long-project-directory/", count: 40),
                host: "node",
                security: "allowlist",
                ask: "on-miss",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1"),
            onDecision: { _ in })
        defer { panel.close() }
        let content = try #require(panel.contentView)
        content.layoutSubtreeIfNeeded()
        let visibleFrame = try #require(NSScreen.main?.visibleFrame)

        #expect(panel.frame.width > 0)
        #expect(panel.sharingType == .none)
        #expect(panel.frame.height > 0)
        #expect(panel.frame.width <= visibleFrame.width)
        #expect(panel.frame.height <= visibleFrame.height)

        let shortPanel = ExecApprovalsPromptPresenter.buildPanel(
            ExecApprovalPromptRequest(command: "/usr/bin/printf ok", ask: "on-miss"),
            onDecision: { _ in })
        defer { shortPanel.close() }
        #expect(shortPanel.frame.height < panel.frame.height)

        let commandView = try #require(self.descendants(of: content).compactMap { $0 as? NSTextView }.first)
        let scrollView = try #require(commandView.enclosingScrollView)
        #expect(commandView.string == ExecApprovalCommandDisplaySanitizer.sanitize(command))
        #expect(!commandView.isEditable)
        #expect(commandView.isSelectable)
        #expect(commandView.isVerticallyResizable)
        #expect(scrollView.hasVerticalScroller)
        #expect(commandView.accessibilityLabel()?.isEmpty == false)
    }

    @Test func `prompt context values escape bidi and control characters`() {
        let spoofed = "safe\u{202E}txt\nnext"

        #expect(
            ExecApprovalsPromptPresenter.sanitizedContextValue(spoofed) ==
                "safe\\u{202E}txt\\u{A}next")
        #expect(ExecApprovalsPromptPresenter.sanitizedContextValue(" \n\t ") == nil)
    }

    private func descendants(of view: NSView) -> [NSView] {
        view.subviews.flatMap { [$0] + self.descendants(of: $0) }
    }
}
