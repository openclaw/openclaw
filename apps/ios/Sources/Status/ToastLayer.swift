import OpenClawChatUI
import SwiftUI
import UIKit

/// M1, the toast motion Victor chose: it fades in, sharpens from a 4 pt blur and drops 12 pt into
/// place, and leaves by the same path, faster. A replacement keeps the capsule and changes its words.
enum ToastMotion {
    static let travel: CGFloat = 12
    static let blur: CGFloat = 4
    static let enter = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.28)
    static let exit = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.16)
    static let reducedEnter = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.2)
    static let reducedExit = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.15)
    /// The capsule's width when the words change, growing or shrinking from the center.
    static let resize = Animation.timingCurve(0.77, 0, 0.175, 1, duration: 0.22)
    static let wordsOut: TimeInterval = 0.12
    static let wordsInDelay: TimeInterval = 0.04
    static let wordsIn: TimeInterval = 0.18
    static let wordsBlur: CGFloat = 2
    static let springBack = Animation.spring(response: 0.3, dampingFraction: 0.8)
    /// Swipe up this far, or flick faster than 0.11 pt/ms, to dismiss.
    static let dismissDistance: CGFloat = 24
    static let dismissVelocity: CGFloat = 110

    static func transition(reduceMotion: Bool) -> AnyTransition {
        if reduceMotion { return .opacity }
        return .modifier(
            active: Phase(offset: -self.travel, opacity: 0, blur: self.blur),
            identity: Phase(offset: 0, opacity: 1, blur: 0))
    }

    struct Phase: ViewModifier {
        let offset: CGFloat
        let opacity: Double
        let blur: CGFloat

        func body(content: Content) -> some View {
            content
                .blur(radius: self.blur)
                .opacity(self.opacity)
                .offset(y: self.offset)
        }
    }
}

/// Draws the presenter's toast. It lives in its own window above the app's (see `ToastWindow`),
/// so it shows over sheets; `onInteractiveFrameChange` tells that window where touches belong.
struct ToastLayer: View {
    let presenter: OpenClawToastPresenter
    let placement: ToastPlacement
    let onInteractiveFrameChange: (CGRect) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown: OpenClawToastSchedule.Entry?
    @State private var outgoing: OpenClawToastSchedule.Entry?
    @State private var drag: CGFloat = 0
    @State private var isTouching = false

    var body: some View {
        VStack(spacing: 0) {
            if let shown {
                self.capsule(shown)
                    .transition(ToastMotion.transition(reduceMotion: self.reduceMotion))
            }
        }
        // The capsule hugs its words; this only caps how wide a long message can grow.
        .frame(maxWidth: 370)
        .padding(.top, self.placement.capsuleTop)
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onChange(of: self.presenter.current?.id, initial: true) {
            self.sync()
        }
        .onChange(of: self.shown == nil) { _, isEmpty in
            if isEmpty { self.onInteractiveFrameChange(.null) }
        }
    }

    private func capsule(_ entry: OpenClawToastSchedule.Entry) -> some View {
        ToastContent(entry: entry, onAction: { self.presenter.performAction(id: entry.id) })
            .modifier(ToastWordsFade(trigger: entry.id, fadesIn: true, reduceMotion: self.reduceMotion))
            .overlay {
                if let outgoing {
                    ToastContent(entry: outgoing, onAction: {})
                        .fixedSize()
                        .modifier(ToastWordsFade(trigger: outgoing.id, fadesIn: false, reduceMotion: self.reduceMotion))
                        .id(outgoing.id)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .clipShape(.capsule)
            .glassEffect(.regular.interactive(), in: .capsule)
            .contentShape(.capsule)
            .offset(y: self.drag)
            .simultaneousGesture(self.swipe(entry))
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
                self.onInteractiveFrameChange(frame)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Toast")
            .accessibilityAction(.escape) { self.presenter.dismiss(id: entry.id) }
            .accessibilityAction(named: Text("Dismiss")) { self.presenter.dismiss(id: entry.id) }
    }

    private func swipe(_ entry: OpenClawToastSchedule.Entry) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .onChanged { value in
                if !self.isTouching {
                    self.isTouching = true
                    self.presenter.hold()
                }
                let height = value.translation.height
                // Up follows the finger; down resists, a quarter of the drag and 10 pt at most.
                self.drag = height < 0 ? height : min(10, height * 0.25)
            }
            .onEnded { value in
                self.isTouching = false
                let height = value.translation.height
                if height < -ToastMotion.dismissDistance
                    || (height < 0 && value.velocity.height < -ToastMotion.dismissVelocity)
                {
                    self.presenter.dismiss(id: entry.id)
                } else {
                    self.presenter.release()
                    withAnimation(ToastMotion.springBack) { self.drag = 0 }
                }
            }
    }

    private func sync() {
        let next = self.presenter.current
        switch (self.shown, next) {
        case (nil, nil):
            return
        case let (nil, next?):
            self.drag = 0
            withAnimation(self.reduceMotion ? ToastMotion.reducedEnter : ToastMotion.enter) {
                self.shown = next
            }
            Self.deliver(next.toast)
        case (_?, nil):
            withAnimation(self.reduceMotion ? ToastMotion.reducedExit : ToastMotion.exit) {
                self.shown = nil
            }
            self.outgoing = nil
        case let (current?, next?):
            guard current.id != next.id else { return }
            self.outgoing = current
            withAnimation(self.reduceMotion ? nil : ToastMotion.resize) {
                self.shown = next
            }
            Self.deliver(next.toast)
            let outgoingID = current.id
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(ToastMotion.wordsOut + 0.02))
                if self.outgoing?.id == outgoingID { self.outgoing = nil }
            }
        }
    }

    /// Haptic and VoiceOver, once per toast. Focus stays where it is.
    private static func deliver(_ toast: OpenClawToast) {
        switch toast.kind {
        case .confirmation:
            break
        case .success:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .warning:
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .error:
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
        AccessibilityNotification.Announcement(toast.announcement ?? toast.text).post()
    }
}

/// The words of a replacement: the old ones fade out in 120 ms and the new ones fade in over
/// 180 ms after 40 ms, each through a 2 pt blur (opacity only with Reduce Motion).
private struct ToastWordsFade: ViewModifier {
    let trigger: Int
    let fadesIn: Bool
    let reduceMotion: Bool

    private struct Value {
        var opacity: Double
        var blur: CGFloat
    }

    private static let curve = UnitCurve.bezier(
        startControlPoint: UnitPoint(x: 0.23, y: 1),
        endControlPoint: UnitPoint(x: 0.32, y: 1))

    func body(content: Content) -> some View {
        if self.fadesIn {
            content.keyframeAnimator(
                initialValue: Value(opacity: 1, blur: 0),
                trigger: self.trigger)
            { content, value in
                content.blur(radius: value.blur).opacity(value.opacity)
            } keyframes: { _ in
                KeyframeTrack(\.opacity) {
                    MoveKeyframe(0)
                    LinearKeyframe(0, duration: ToastMotion.wordsInDelay)
                    LinearKeyframe(1, duration: ToastMotion.wordsIn, timingCurve: Self.curve)
                }
                KeyframeTrack(\.blur) {
                    MoveKeyframe(self.reduceMotion ? 0 : ToastMotion.wordsBlur)
                    LinearKeyframe(self.reduceMotion ? 0 : ToastMotion.wordsBlur, duration: ToastMotion.wordsInDelay)
                    LinearKeyframe(0, duration: ToastMotion.wordsIn, timingCurve: Self.curve)
                }
            }
        } else {
            content.keyframeAnimator(
                initialValue: Value(opacity: 1, blur: 0),
                repeating: false)
            { content, value in
                content.blur(radius: value.blur).opacity(value.opacity)
            } keyframes: { _ in
                KeyframeTrack(\.opacity) {
                    LinearKeyframe(0, duration: ToastMotion.wordsOut, timingCurve: Self.curve)
                }
                KeyframeTrack(\.blur) {
                    LinearKeyframe(self.reduceMotion ? 0 : ToastMotion.wordsBlur, duration: ToastMotion.wordsOut)
                }
            }
        }
    }
}

/// One line (two at large text sizes or for a long name), an optional icon, at most one action.
struct ToastContent: View {
    let entry: OpenClawToastSchedule.Entry
    let onAction: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var iconSize: CGFloat = 19

    var body: some View {
        HStack(spacing: 10) {
            if let systemImage = self.entry.toast.systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: self.iconSize * 0.8, weight: .semibold))
                    .frame(width: self.iconSize, height: self.iconSize)
                    .accessibilityHidden(true)
            }
            Text(verbatim: self.entry.toast.text)
                .font(OpenClawType.subheadMedium)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 12)
                .accessibilityIdentifier("Toast.Text")
            if let action = self.entry.toast.action {
                Button(action: self.onAction) {
                    Text(verbatim: action.title)
                        .font(OpenClawType.subheadSemiBold)
                        .underline()
                        .lineLimit(1)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .contentShape(.capsule)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("Toast.Action")
            }
        }
        .foregroundStyle(.primary)
        .padding(.leading, 14)
        .padding(.trailing, self.entry.toast.action == nil ? 18 : 6)
        .frame(minHeight: 44)
    }
}
