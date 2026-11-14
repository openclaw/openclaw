import OpenClawKit
import SwiftUI
import UIKit
import XCTest
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
final class ChatSendOptionsRenderingTests: XCTestCase {
    func testBusyDraftExplainsEffectiveDefaultAndHidesWhenIneligible() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: LocalFixtureChatTransport(fixture: .appleReviewDemo),
            outbox: databases.store(gatewayID: "send-options-proof"))
        model.load()
        await model.bootstrapTask?.value
        defer { model.detachTransport() }
        model.pendingRuns.insert("active-response")
        model.input = "Please include the next steps."

        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 700)
        let controller = UIHostingController(rootView: Self.composer(model))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousWindow?.makeKeyAndVisible()
        }

        try await self.checkDefaults(model: model, controller: controller)
        for input in ["", "/new"] {
            model.input = input
            await self.settle(controller.view)
            XCTAssertNil(Self.findOptions(in: controller.view), "Ineligible drafts must not offer overrides")
        }
        model.input = "Please include the next steps."
        model.pendingRuns.removeAll()
        await self.settle(controller.view)
        XCTAssertNil(Self.findOptions(in: controller.view), "Idle sends must not show busy-send options")
    }

    private func checkDefaults(
        model: OpenClawChatViewModel,
        controller: UIHostingController<some View>) async throws
    {
        for (mode, expected) in [
            ("collect", "Default: Collect."),
            ("steer", "Default: Steer now."),
            ("followup", "Default: Queue next."),
            ("future-mode", "Default: Gateway setting."),
        ] {
            model.sessions = try [JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(
                "{\"key\":\"main\",\"effectiveQueueMode\":\"\(mode)\"}".utf8))]
            await self.settle(controller.view)
            let image = UIGraphicsImageRenderer(bounds: controller.view.bounds).image { _ in
                controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "send-options-\(mode)"
            attachment.lifetime = .keepAlways
            self.add(attachment)
            let options = try XCTUnwrap(Self.findOptions(in: controller.view), "The menu must be discoverable")
            XCTAssertTrue(options.accessibilityValue?.contains(expected) == true)
            XCTAssertGreaterThanOrEqual(options.accessibilityFrame.height, 44)
        }
    }

    private static func composer(_ model: OpenClawChatViewModel) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("A reply is in progress.").font(OpenClawType.body)
            Spacer()
            OpenClawChatComposer(
                viewModel: model,
                style: .standard,
                showsSessionSwitcher: false,
                userAccent: nil,
                composerChrome: .clean,
                isComposerEnabled: true,
                isAttachmentInputEnabled: true,
                messagePlaceholder: nil,
                talkControl: nil,
                dictationControl: nil,
                voiceNoteControl: nil)
        }
        .padding(16)
        .background(Color.white)
        .preferredColorScheme(.light)
    }

    private func settle(_ view: UIView) async {
        view.setNeedsLayout()
        view.layoutIfNeeded()
        try? await Task.sleep(for: .milliseconds(200))
        view.layoutIfNeeded()
    }

    private static func findOptions(in root: NSObject) -> NSObject? {
        var visited = Set<ObjectIdentifier>()
        func visit(_ object: NSObject) -> NSObject? {
            guard visited.insert(ObjectIdentifier(object)).inserted else { return nil }
            if (object as? UIAccessibilityIdentification)?.accessibilityIdentifier == "chat-send-options" {
                return object
            }
            if let view = object as? UIView {
                for child in view.subviews {
                    if let found = visit(child) { return found }
                }
            }
            let count = object.accessibilityElementCount()
            if count > 0, count < 1000 {
                for index in 0..<count {
                    if let child = object.accessibilityElement(at: index) as? NSObject,
                       let found = visit(child)
                    { return found }
                }
            }
            return nil
        }
        return visit(root)
    }
}
