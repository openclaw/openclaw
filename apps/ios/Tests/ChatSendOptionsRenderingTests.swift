import OpenClawKit
import SwiftUI
import UIKit
import Vision
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
        let draft = model.input
        for input in ["", "/new"] {
            model.input = input
            _ = try await self.waitForRenderedText(in: controller.view) { !$0.contains("Send options") }
            model.input = draft
            _ = try await self.waitForRenderedText(in: controller.view) { $0.contains("Send options") }
        }
        model.pendingRuns.removeAll()
        _ = try await self.waitForRenderedText(in: controller.view) { !$0.contains("Send options") }
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
            let image = try await self.waitForRenderedText(in: controller.view) {
                $0.contains("Send options") && $0.contains(expected)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "send-options-\(mode)"
            attachment.lifetime = .keepAlways
            self.add(attachment)
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

    private func waitForRenderedText(
        in view: UIView,
        file: StaticString = #filePath,
        line: UInt = #line,
        matching expected: (String) -> Bool) async throws -> UIImage
    {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(3))
        let recognition = VNRecognizeTextRequest()
        recognition.recognitionLanguages = ["en-US"]
        recognition.regionOfInterest = CGRect(x: 0, y: 0, width: 1, height: 0.5)
        repeat {
            view.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: view.bounds).image { _ in
                view.drawHierarchy(in: view.bounds, afterScreenUpdates: true)
            }
            let pixels = try XCTUnwrap(image.cgImage, file: file, line: line)
            try VNImageRequestHandler(cgImage: pixels).perform([recognition])
            let text = recognition.results?.compactMap { $0.topCandidates(1).first?.string }
                .joined(separator: " ") ?? ""
            if expected(text) { return image }
            try await clock.sleep(for: .milliseconds(100))
        } while clock.now < deadline
        return try XCTUnwrap(
            nil as UIImage?,
            "Send Options did not render the expected text",
            file: file,
            line: line)
    }
}
