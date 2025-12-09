import AppKit
import SwiftUI

struct CritterStatusLabel: View {
    var isPaused: Bool
    var isWorking: Bool
    var earBoostActive: Bool
    var blinkTick: Int
    var sendCelebrationTick: Int
    var relayStatus: RelayProcessManager.Status
    var animationsEnabled: Bool
    var iconState: IconState

    @State private var blinkAmount: CGFloat = 0
    @State private var nextBlink = Date().addingTimeInterval(Double.random(in: 3.5...8.5))
    @State private var wiggleAngle: Double = 0
    @State private var wiggleOffset: CGFloat = 0
    @State private var nextWiggle = Date().addingTimeInterval(Double.random(in: 6.5...14))
    @State private var legWiggle: CGFloat = 0
    @State private var nextLegWiggle = Date().addingTimeInterval(Double.random(in: 5.0...11.0))
    @State private var earWiggle: CGFloat = 0
    @State private var nextEarWiggle = Date().addingTimeInterval(Double.random(in: 7.0...14.0))
    private let ticker = Timer.publish(every: 0.35, on: .main, in: .common).autoconnect()

    private var isWorkingNow: Bool {
        self.iconState.isWorking || self.isWorking
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if self.isPaused {
                    Image(nsImage: CritterIconRenderer.makeIcon(blink: 0))
                        .frame(width: 18, height: 16)
                } else {
                    Image(nsImage: CritterIconRenderer.makeIcon(
                        blink: self.blinkAmount,
                        legWiggle: max(self.legWiggle, self.isWorkingNow ? 0.6 : 0),
                        earWiggle: self.earWiggle,
                        earScale: self.earBoostActive ? 1.9 : 1.0,
                        earHoles: self.earBoostActive))
                        .frame(width: 18, height: 16)
                        .rotationEffect(.degrees(self.wiggleAngle), anchor: .center)
                        .offset(x: self.wiggleOffset)
                        .onReceive(self.ticker) { now in
                            guard self.animationsEnabled, !self.earBoostActive else {
                                self.resetMotion()
                                return
                            }

                            if now >= self.nextBlink {
                                self.blink()
                                self.nextBlink = now.addingTimeInterval(Double.random(in: 3.5...8.5))
                            }

                            if now >= self.nextWiggle {
                                self.wiggle()
                                self.nextWiggle = now.addingTimeInterval(Double.random(in: 6.5...14))
                            }

                            if now >= self.nextLegWiggle {
                                self.wiggleLegs()
                                self.nextLegWiggle = now.addingTimeInterval(Double.random(in: 5.0...11.0))
                            }

                            if now >= self.nextEarWiggle {
                                self.wiggleEars()
                                self.nextEarWiggle = now.addingTimeInterval(Double.random(in: 7.0...14.0))
                            }

                            if self.isWorkingNow {
                                self.scurry()
                            }
                        }
                        .onChange(of: self.isPaused) { _, _ in self.resetMotion() }
                        .onChange(of: self.blinkTick) { _, _ in
                            guard !self.earBoostActive else { return }
                            self.blink()
                        }
                        .onChange(of: self.sendCelebrationTick) { _, _ in
                            guard !self.earBoostActive else { return }
                            self.wiggleLegs()
                        }
                        .onChange(of: self.animationsEnabled) { _, enabled in
                            if enabled {
                                self.scheduleRandomTimers(from: Date())
                            } else {
                                self.resetMotion()
                            }
                        }
                        .onChange(of: self.earBoostActive) { _, active in
                            if active {
                                self.resetMotion()
                            } else if self.animationsEnabled {
                                self.scheduleRandomTimers(from: Date())
                            }
                        }
                }
            }

            if self.relayNeedsAttention {
                Circle()
                    .fill(self.relayBadgeColor)
                    .frame(width: 8, height: 8)
                    .offset(x: 4, y: 4)
            }

            if case .idle = self.iconState {
                EmptyView()
            } else {
                Text(self.iconState.glyph)
                    .font(.system(size: 9))
                    .padding(3)
                    .background(
                        Circle()
                            .fill(self.iconState.tint.opacity(0.9)))
                    .foregroundStyle(Color.white)
                    .offset(x: -4, y: -2)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            }
        }
    }

    private func resetMotion() {
        self.blinkAmount = 0
        self.wiggleAngle = 0
        self.wiggleOffset = 0
        self.legWiggle = 0
        self.earWiggle = 0
    }

    private func blink() {
        withAnimation(.easeInOut(duration: 0.08)) { self.blinkAmount = 1 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) {
            withAnimation(.easeOut(duration: 0.12)) { self.blinkAmount = 0 }
        }
    }

    private func wiggle() {
        let targetAngle = Double.random(in: -4.5...4.5)
        let targetOffset = CGFloat.random(in: -0.5...0.5)
        withAnimation(.interpolatingSpring(stiffness: 220, damping: 18)) {
            self.wiggleAngle = targetAngle
            self.wiggleOffset = targetOffset
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.36) {
            withAnimation(.interpolatingSpring(stiffness: 220, damping: 18)) {
                self.wiggleAngle = 0
                self.wiggleOffset = 0
            }
        }
    }

    private func wiggleLegs() {
        let target = CGFloat.random(in: 0.35...0.9)
        withAnimation(.easeInOut(duration: 0.14)) {
            self.legWiggle = target
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
            withAnimation(.easeOut(duration: 0.18)) { self.legWiggle = 0 }
        }
    }

    private func scurry() {
        let target = CGFloat.random(in: 0.7...1.0)
        withAnimation(.easeInOut(duration: 0.12)) {
            self.legWiggle = target
            self.wiggleOffset = CGFloat.random(in: -0.6...0.6)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
            withAnimation(.easeOut(duration: 0.16)) {
                self.legWiggle = 0.25
                self.wiggleOffset = 0
            }
        }
    }

    private func wiggleEars() {
        let target = CGFloat.random(in: -1.2...1.2)
        withAnimation(.interpolatingSpring(stiffness: 260, damping: 19)) {
            self.earWiggle = target
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) {
            withAnimation(.interpolatingSpring(stiffness: 260, damping: 19)) { self.earWiggle = 0 }
        }
    }

    private func scheduleRandomTimers(from date: Date) {
        self.nextBlink = date.addingTimeInterval(Double.random(in: 3.5...8.5))
        self.nextWiggle = date.addingTimeInterval(Double.random(in: 6.5...14))
        self.nextLegWiggle = date.addingTimeInterval(Double.random(in: 5.0...11.0))
        self.nextEarWiggle = date.addingTimeInterval(Double.random(in: 7.0...14.0))
    }

    private var relayNeedsAttention: Bool {
        switch self.relayStatus {
        case .failed, .stopped:
            !self.isPaused
        case .starting, .restarting, .running:
            false
        }
    }

    private var relayBadgeColor: Color {
        switch self.relayStatus {
        case .failed: .red
        case .stopped: .orange
        default: .clear
        }
    }
}

enum CritterIconRenderer {
    private static let size = NSSize(width: 18, height: 16)

    static func makeIcon(
        blink: CGFloat,
        legWiggle: CGFloat = 0,
        earWiggle: CGFloat = 0,
        earScale: CGFloat = 1,
        earHoles: Bool = false) -> NSImage
    {
        let image = NSImage(size: size)
        image.lockFocus()
        defer { image.unlockFocus() }

        guard let ctx = NSGraphicsContext.current?.cgContext else { return image }

        let w = self.size.width
        let h = self.size.height

        let bodyW = w * 0.78
        let bodyH = h * 0.58
        let bodyX = (w - bodyW) / 2
        let bodyY = h * 0.36
        let bodyCorner = w * 0.09

        let earW = w * 0.22
        let earH = bodyH * 0.66 * earScale * (1 - 0.08 * abs(earWiggle))
        let earCorner = earW * 0.24
        let leftEarRect = CGRect(
            x: bodyX - earW * 0.55 + earWiggle,
            y: bodyY + bodyH * 0.08 + earWiggle * 0.4,
            width: earW,
            height: earH)
        let rightEarRect = CGRect(
            x: bodyX + bodyW - earW * 0.45 - earWiggle,
            y: bodyY + bodyH * 0.08 - earWiggle * 0.4,
            width: earW,
            height: earH)

        let legW = w * 0.11
        let legH = h * 0.26
        let legSpacing = w * 0.085
        let legsWidth = 4 * legW + 3 * legSpacing
        let legStartX = (w - legsWidth) / 2
        let legLift = legH * 0.35 * legWiggle
        let legYBase = bodyY - legH + h * 0.05

        let eyeOpen = max(0.05, 1 - blink)
        let eyeW = bodyW * 0.2
        let eyeH = bodyH * 0.26 * eyeOpen
        let eyeY = bodyY + bodyH * 0.56
        let eyeOffset = bodyW * 0.24

        ctx.setFillColor(NSColor.labelColor.cgColor)

        ctx.addPath(CGPath(
            roundedRect: CGRect(x: bodyX, y: bodyY, width: bodyW, height: bodyH),
            cornerWidth: bodyCorner,
            cornerHeight: bodyCorner,
            transform: nil))
        ctx.addPath(CGPath(
            roundedRect: leftEarRect,
            cornerWidth: earCorner,
            cornerHeight: earCorner,
            transform: nil))
        ctx.addPath(CGPath(
            roundedRect: rightEarRect,
            cornerWidth: earCorner,
            cornerHeight: earCorner,
            transform: nil))
        for i in 0..<4 {
            let x = legStartX + CGFloat(i) * (legW + legSpacing)
            let lift = (i % 2 == 0 ? legLift : -legLift)
            let rect = CGRect(x: x, y: legYBase + lift, width: legW, height: legH * (1 - 0.12 * legWiggle))
            ctx.addPath(CGPath(roundedRect: rect, cornerWidth: legW * 0.34, cornerHeight: legW * 0.34, transform: nil))
        }
        ctx.fillPath()

        ctx.saveGState()
        ctx.setBlendMode(.clear)

        let leftCenter = CGPoint(x: w / 2 - eyeOffset, y: eyeY)
        let rightCenter = CGPoint(x: w / 2 + eyeOffset, y: eyeY)

        if earHoles || earScale > 1.05 {
            let holeW = earW * 0.6
            let holeH = earH * 0.46
            let holeCorner = holeW * 0.34
            let leftHoleRect = CGRect(
                x: leftEarRect.midX - holeW / 2,
                y: leftEarRect.midY - holeH / 2 + earH * 0.04,
                width: holeW,
                height: holeH)
            let rightHoleRect = CGRect(
                x: rightEarRect.midX - holeW / 2,
                y: rightEarRect.midY - holeH / 2 + earH * 0.04,
                width: holeW,
                height: holeH)

            ctx.addPath(CGPath(
                roundedRect: leftHoleRect,
                cornerWidth: holeCorner,
                cornerHeight: holeCorner,
                transform: nil))
            ctx.addPath(CGPath(
                roundedRect: rightHoleRect,
                cornerWidth: holeCorner,
                cornerHeight: holeCorner,
                transform: nil))
        }

        let left = CGMutablePath()
        left.move(to: CGPoint(x: leftCenter.x - eyeW / 2, y: leftCenter.y - eyeH))
        left.addLine(to: CGPoint(x: leftCenter.x + eyeW / 2, y: leftCenter.y))
        left.addLine(to: CGPoint(x: leftCenter.x - eyeW / 2, y: leftCenter.y + eyeH))
        left.closeSubpath()

        let right = CGMutablePath()
        right.move(to: CGPoint(x: rightCenter.x + eyeW / 2, y: rightCenter.y - eyeH))
        right.addLine(to: CGPoint(x: rightCenter.x - eyeW / 2, y: rightCenter.y))
        right.addLine(to: CGPoint(x: rightCenter.x + eyeW / 2, y: rightCenter.y + eyeH))
        right.closeSubpath()

        ctx.addPath(left)
        ctx.addPath(right)
        ctx.fillPath()
        ctx.restoreGState()

        image.isTemplate = true
        return image
    }
}
