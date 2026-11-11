import QuartzCore
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct RootSidebarShellContinuityTests {
    private final class Recorder {
        var label: UILabel?
        var setDraft: ((String) -> Void)?
    }

    private struct ProbeLabel: UIViewRepresentable {
        let identity: UUID
        @Binding var draft: String
        let recorder: Recorder

        func makeUIView(context: Context) -> UILabel {
            UILabel()
        }

        func updateUIView(_ label: UILabel, context: Context) {
            label.text = "\(self.identity.uuidString)|\(self.draft)"
            self.recorder.label = label
            self.recorder.setDraft = { self.draft = $0 }
        }
    }

    private struct StatefulDetail: View {
        @State private var identity = UUID()
        @State private var draft = ""
        let recorder: Recorder

        var body: some View {
            ProbeLabel(identity: self.identity, draft: self.$draft, recorder: self.recorder)
        }
    }

    private struct Harness: View {
        let isDrawer: Bool
        let isPresented: Bool
        let reduceMotion: Bool
        let recorder: Recorder

        var body: some View {
            RootSidebarShell(
                sidebarWidth: 316,
                isDrawerLayout: self.isDrawer,
                isPresented: self.isPresented,
                canOpenFromEdge: true,
                reduceMotion: self.reduceMotion,
                animation: nil,
                onShow: {},
                onHide: {},
                sidebar: Color.clear,
                detail: StatefulDetail(recorder: self.recorder),
                contentSafeAreaInsets: .init())
        }
    }

    @Test func `closed card mask includes native bars on every safe area edge`() {
        let bounds = CGRect(x: 0, y: 0, width: 500, height: 700)
        let insets = EdgeInsets(top: 50, leading: 70, bottom: 30, trailing: 90)
        let closed = RootSidebarContentClipShape(progress: 0, safeAreaInsets: insets).path(in: bounds)
        let open = RootSidebarContentClipShape(progress: 1, safeAreaInsets: insets).path(in: bounds)
        for barPoint in [
            CGPoint(x: 250, y: -25), CGPoint(x: -35, y: 350),
            CGPoint(x: 250, y: 715), CGPoint(x: 545, y: 350),
        ] {
            #expect(closed.contains(barPoint))
            #expect(!open.contains(barPoint))
        }
        #expect(closed.contains(CGPoint(x: 1, y: 1)))
        #expect(!open.contains(CGPoint(x: 1, y: 1)))
        #expect(RootSidebarContentClipShape(progress: -0.05, safeAreaInsets: insets).path(in: bounds).boundingRect ==
            closed.boundingRect)
        #expect(RootSidebarContentClipShape(progress: 1.05, safeAreaInsets: insets).path(in: bounds).boundingRect ==
            open.boundingRect)
    }

    @Test(arguments: [false, true])
    func `detail local state and native view survive layout and visibility transitions`(reduceMotion: Bool) throws {
        let recorder = Recorder()
        let host = UIHostingController(rootView: Harness(
            isDrawer: true, isPresented: false, reduceMotion: reduceMotion, recorder: recorder))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 744, height: 1133))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        host.view.layoutIfNeeded()
        CATransaction.flush()
        let originalLabel = try #require(recorder.label)
        let setDraft = try #require(recorder.setDraft)
        setDraft("Unsent draft survives resizing")
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        CATransaction.flush()
        let originalText = try #require(originalLabel.text)
        #expect(originalText.hasSuffix("|Unsent draft survives resizing"))

        for (isDrawer, isPresented, width): (Bool, Bool, CGFloat) in [
            (true, true, 744),
            (false, true, 1133),
            (false, false, 1133),
            (false, true, 1133),
            (true, false, 744),
        ] {
            window.frame.size.width = width
            host.rootView = Harness(
                isDrawer: isDrawer, isPresented: isPresented, reduceMotion: reduceMotion, recorder: recorder)
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            CATransaction.flush()
            #expect(recorder.label === originalLabel)
            #expect(recorder.label?.text == originalText)
        }
    }
}
