#if os(iOS)
import Foundation
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import OpenClawChatUI

/// Exercises the real reader callbacks, not a second implementation of their readiness predicate.
@MainActor
final class ChatHistoryReadinessRenderingTests: XCTestCase {
    func testOutboxReaderAfterHistoryFailureAndSettledReplacement() async throws {
        let (store, databases, directory) = try makeOutboxStore()
        defer {
            try? databases.close()
            try? FileManager.default.removeItem(at: directory)
        }
        let rowCount = 24
        let now = Date().timeIntervalSince1970 * 1000
        for index in 0..<rowCount {
            let saved = await store.enqueueCommand(outboxTestCommand(
                id: "readiness-\(index)",
                text: "Queued offline question \(index): keep this message visible while the gateway is unavailable.",
                createdAt: now + Double(index)))
            XCTAssertTrue(saved)
        }
        let historyGate = OutboxTestGate()
        let transport = TestChatTransport(historyResponses: [], requestHistoryHook: { _ in
            await historyGate.wait()
            throw NSError(domain: "HistoryReadinessTest", code: 1)
        })
        let vm = OpenClawChatViewModel(
            sessionKey: "main",
            transport: transport,
            activeAgentId: "main",
            sessionRoutingContract: "per-sender|main|main",
            outbox: store)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        defer {
            vm.detachTransport()
            window.isHidden = true
            window.rootViewController = nil
        }
        let rowsRenderedWhileLoading = self.expectation(description: "durable rows rendered during history request")
        let failureRendered = self.expectation(description: "history failure rendered")
        var sawLoading = false
        var sawFailure = false
        let host = UIHostingController(rootView: ReadinessRenderedChat(viewModel: vm) { loading, count in
            if loading, count == rowCount, !sawLoading {
                sawLoading = true
                rowsRenderedWhileLoading.fulfill()
            }
            if sawLoading, !loading, count == rowCount, !sawFailure {
                sawFailure = true
                failureRendered.fulfill()
            }
        })
        window.rootViewController = host
        window.isHidden = false
        host.view.layoutIfNeeded()
        await self.fulfillment(of: [rowsRenderedWhileLoading], timeout: 5)
        let bootstrap = try XCTUnwrap(vm.bootstrapTask)
        XCTAssertFalse(vm.hasReadableHistory)
        XCTAssertTrue(vm.hasRestoredOutboxMessages)
        let scroller = try XCTUnwrap(Self.descendant(UIScrollView.self, in: host.view))
        XCTAssertGreaterThan(chatTranscriptBottomOffset(scroller), 400)
        // Make the failed-load fallback observable even if a lazy-list layout already reached its tail.
        scroller.setContentOffset(CGPoint(x: 0, y: -scroller.adjustedContentInset.top), animated: false)
        let positioned = self.expectation(description: "failed load restores initial reader position")
        positioned.assertForOverFulfill = false
        let observation = scroller.observe(\.contentOffset, options: [.new]) { scroller, _ in
            MainActor.assumeIsolated {
                if !vm.isLoading, abs(scroller.contentOffset.y - chatTranscriptBottomOffset(scroller)) < 1 {
                    positioned.fulfill()
                }
            }
        }
        defer { observation.invalidate() }
        await historyGate.release()
        await bootstrap.value
        await self.fulfillment(of: [failureRendered, positioned], timeout: 5)
        XCTAssertFalse(vm.hasReadableHistory)
        XCTAssertFalse(vm.isLoading)
        XCTAssertNotNil(vm.errorText)
        XCTAssertEqual(vm.messages.count, rowCount)
        XCTAssertFalse(vm.healthOK)
        XCTAssertFalse(vm.hasCurrentSessionMetadata)
        let sentMessages = await transport.sentMessages()
        XCTAssertTrue(sentMessages.isEmpty)

        let probe = try XCTUnwrap(Self.descendant(ChatSynchronousFollowProbe.Probe.self, in: host.view))
        let follow = try XCTUnwrap(probe.followState)
        let released = self.expectation(description: "reader navigation releases following after history failure")
        withObservationTracking { _ = follow.followTarget } onChange: { released.fulfill() }
        scroller.setContentOffset(CGPoint(x: 0, y: -scroller.adjustedContentInset.top), animated: true)
        await self.fulfillment(of: [released], timeout: 5)
        XCTAssertNil(follow.followTarget)

        // A settled failed model can replace this presentation without an isLoading transition.
        let replacementTransport = TestChatTransport(historyResponses: [], historyResponseHook: { _, call, _ in
            XCTAssertEqual(call, 0, "Replacement must not be rescued by another onAppear load")
            throw NSError(domain: "HistoryReadinessTest", code: 2)
        })
        let replacement = OpenClawChatViewModel(
            sessionKey: "main",
            transport: replacementTransport,
            activeAgentId: "main",
            sessionRoutingContract: "per-sender|main|main",
            outbox: store)
        defer { replacement.detachTransport() }
        replacement.load()
        await replacement.bootstrapTask?.value
        let restored = self.expectation(description: "replacement outbox restored")
        if withObservationTracking({ replacement.hasRestoredOutboxMessages }, onChange: { restored.fulfill() }) {
            restored.fulfill()
        }
        await self.fulfillment(of: [restored], timeout: 5)
        XCTAssertFalse(replacement.isLoading)
        XCTAssertFalse(replacement.hasReadableHistory)
        XCTAssertEqual(replacement.messages.count, rowCount)
        vm.detachTransport()
        let replacementRendered = self.expectation(description: "settled replacement rendered")
        replacementRendered.assertForOverFulfill = false
        host.rootView = ReadinessRenderedChat(viewModel: replacement) { loading, count in
            if !loading, count == rowCount { replacementRendered.fulfill() }
        }
        await self.fulfillment(of: [replacementRendered], timeout: 5)
        let replacementScroller = try XCTUnwrap(Self.descendant(UIScrollView.self, in: host.view))
        let replacementPositioned = self.expectation(description: "replacement positioned")
        replacementPositioned.assertForOverFulfill = false
        let replacementObservation = replacementScroller.observe(\.contentOffset, options: [.initial, .new]) { scroll, _ in
            MainActor.assumeIsolated {
                if abs(scroll.contentOffset.y - chatTranscriptBottomOffset(scroll)) < 1 {
                    replacementPositioned.fulfill()
                }
            }
        }
        defer { replacementObservation.invalidate() }
        await self.fulfillment(of: [replacementPositioned], timeout: 5)
        let replacementProbe = try XCTUnwrap(Self.descendant(ChatSynchronousFollowProbe.Probe.self, in: host.view))
        let replacementFollow = try XCTUnwrap(replacementProbe.followState)
        let replacementReleased = self.expectation(description: "settled replacement releases following")
        withObservationTracking { _ = replacementFollow.followTarget } onChange: { replacementReleased.fulfill() }
        replacementScroller.setContentOffset(
            CGPoint(x: 0, y: -replacementScroller.adjustedContentInset.top),
            animated: true)
        await self.fulfillment(of: [replacementReleased], timeout: 5)
        XCTAssertNil(replacementFollow.followTarget)
    }

    private static func descendant<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let match = view as? T { return match }
        for child in view.subviews {
            if let match = self.descendant(type, in: child) { return match }
        }
        return nil
    }
}

private struct ReadinessRenderedChat: View {
    let viewModel: OpenClawChatViewModel
    let rendered: @MainActor (Bool, Int) -> Void

    var body: some View {
        OpenClawChatView(viewModel: self.viewModel, showsComposer: false)
            .overlay {
                ReadinessRenderCheckpoint(
                    loading: self.viewModel.isLoading,
                    count: self.viewModel.messages.count,
                    rendered: self.rendered)
                    .frame(width: 1, height: 1)
                    .allowsHitTesting(false)
            }
    }
}

private struct ReadinessRenderCheckpoint: UIViewRepresentable {
    let loading: Bool
    let count: Int
    let rendered: @MainActor (Bool, Int) -> Void

    func makeUIView(context: Context) -> UIView { UIView() }

    func updateUIView(_: UIView, context: Context) {
        self.rendered(self.loading, self.count)
    }
}
#endif
