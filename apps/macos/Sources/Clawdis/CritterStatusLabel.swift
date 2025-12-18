import AppKit
import SwiftUI

struct CritterStatusLabel: View {
    var isPaused: Bool
    var isWorking: Bool
    var earBoostActive: Bool
    var blinkTick: Int
    var sendCelebrationTick: Int
    var gatewayStatus: GatewayProcessManager.Status
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

    private var isWorkingNow: Bool {
        self.iconState.isWorking || self.isWorking
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            self.iconImage
                .frame(width: 18, height: 18)
                .rotationEffect(.degrees(self.wiggleAngle), anchor: .center)
                .offset(x: self.wiggleOffset)
                // Avoid Combine's TimerPublisher here: on macOS 26.2 we've seen crashes inside executor checks
                // triggered by its callbacks. Drive periodic updates via a Swift-concurrency task instead.
                .task(id: self.tickTaskID) {
                    guard self.animationsEnabled, !self.earBoostActive else {
                        await MainActor.run { self.resetMotion() }
                        return
                    }

                    while !Task.isCancelled {
                        let now = Date()
                        await MainActor.run { self.tick(now) }
                        try? await Task.sleep(nanoseconds: 350_000_000)
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

            if self.gatewayNeedsAttention {
                Circle()
                    .fill(self.gatewayBadgeColor)
                    .frame(width: 6, height: 6)
                    .padding(1)
            }
        }
        .frame(width: 18, height: 18)
    }

    private var tickTaskID: Int {
        // Ensure SwiftUI restarts (and cancels) the task when these change.
        (self.animationsEnabled ? 1 : 0) | (self.earBoostActive ? 2 : 0)
    }

    private func tick(_ now: Date) {
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

    private var iconImage: Image {
        let badge: CritterIconRenderer.Badge? = if let prominence = self.iconState.badgeProminence, !self.isPaused {
            CritterIconRenderer.Badge(
                symbolName: self.iconState.badgeSymbolName,
                prominence: prominence)
        } else {
            nil
        }

        if self.isPaused {
            return Image(nsImage: CritterIconRenderer.makeIcon(blink: 0, badge: nil))
        }

        return Image(nsImage: CritterIconRenderer.makeIcon(
            blink: self.blinkAmount,
            legWiggle: max(self.legWiggle, self.isWorkingNow ? 0.6 : 0),
            earWiggle: self.earWiggle,
            earScale: self.earBoostActive ? 1.9 : 1.0,
            earHoles: self.earBoostActive,
            badge: badge))
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
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 160_000_000)
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
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 360_000_000)
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
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 220_000_000)
            withAnimation(.easeOut(duration: 0.18)) { self.legWiggle = 0 }
        }
    }

    private func scurry() {
        let target = CGFloat.random(in: 0.7...1.0)
        withAnimation(.easeInOut(duration: 0.12)) {
            self.legWiggle = target
            self.wiggleOffset = CGFloat.random(in: -0.6...0.6)
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000)
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
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 320_000_000)
            withAnimation(.interpolatingSpring(stiffness: 260, damping: 19)) {
                self.earWiggle = 0
            }
        }
    }

    private func scheduleRandomTimers(from date: Date) {
        self.nextBlink = date.addingTimeInterval(Double.random(in: 3.5...8.5))
        self.nextWiggle = date.addingTimeInterval(Double.random(in: 6.5...14))
        self.nextLegWiggle = date.addingTimeInterval(Double.random(in: 5.0...11.0))
        self.nextEarWiggle = date.addingTimeInterval(Double.random(in: 7.0...14.0))
    }

    private var gatewayNeedsAttention: Bool {
        switch self.gatewayStatus {
        case .failed, .stopped:
            !self.isPaused
        case .starting, .restarting, .running, .attachedExisting:
            false
        }
    }

    private var gatewayBadgeColor: Color {
        switch self.gatewayStatus {
        case .failed: .red
        case .stopped: .orange
        default: .clear
        }
    }
}

enum CritterIconRenderer {
    private static let size = NSSize(width: 18, height: 18)

    struct Badge {
        let symbolName: String
        let prominence: IconState.BadgeProminence
    }

    private struct Canvas {
        let w: CGFloat
        let h: CGFloat
        let snapX: (CGFloat) -> CGFloat
        let snapY: (CGFloat) -> CGFloat
        let context: CGContext
    }

    static func makeIcon(
        blink: CGFloat,
        legWiggle: CGFloat = 0,
        earWiggle: CGFloat = 0,
        earScale: CGFloat = 1,
        earHoles: Bool = false,
        badge: Badge? = nil) -> NSImage
    {
        // Force a 36×36px backing store (2× for the 18pt logical canvas) so the menu bar icon stays crisp on Retina.
        let pixelsWide = 36
        let pixelsHigh = 36
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixelsWide,
            pixelsHigh: pixelsHigh,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bitmapFormat: [],
            bytesPerRow: 0,
            bitsPerPixel: 0)
        else {
            return NSImage(size: self.size)
        }
        rep.size = self.size

        NSGraphicsContext.saveGraphicsState()
        if let context = NSGraphicsContext(bitmapImageRep: rep) {
            NSGraphicsContext.current = context
            context.imageInterpolation = .none
            context.cgContext.setShouldAntialias(false)
            defer { NSGraphicsContext.restoreGraphicsState() }

            let stepX = self.size.width / max(CGFloat(rep.pixelsWide), 1)
            let stepY = self.size.height / max(CGFloat(rep.pixelsHigh), 1)
            let snapX: (CGFloat) -> CGFloat = { ($0 / stepX).rounded() * stepX }
            let snapY: (CGFloat) -> CGFloat = { ($0 / stepY).rounded() * stepY }

            let w = snapX(size.width)
            let h = snapY(size.height)

            let bodyW = snapX(w * 0.78)
            let bodyH = snapY(h * 0.58)
            let bodyX = snapX((w - bodyW) / 2)
            let bodyY = snapY(h * 0.36)
            let bodyCorner = snapX(w * 0.09)

            let earW = snapX(w * 0.22)
            let earH = snapY(bodyH * 0.54 * earScale * (1 - 0.08 * abs(earWiggle)))
            let earCorner = snapX(earW * 0.24)
            let leftEarRect = CGRect(
                x: snapX(bodyX - earW * 0.55 + earWiggle),
                y: snapY(bodyY + bodyH * 0.08 + earWiggle * 0.4),
                width: earW,
                height: earH)
            let rightEarRect = CGRect(
                x: snapX(bodyX + bodyW - earW * 0.45 - earWiggle),
                y: snapY(bodyY + bodyH * 0.08 - earWiggle * 0.4),
                width: earW,
                height: earH)

            let legW = snapX(w * 0.11)
            let legH = snapY(h * 0.26)
            let legSpacing = snapX(w * 0.085)
            let legsWidth = snapX(4 * legW + 3 * legSpacing)
            let legStartX = snapX((w - legsWidth) / 2)
            let legLift = snapY(legH * 0.35 * legWiggle)
            let legYBase = snapY(bodyY - legH + h * 0.05)

            let eyeOpen = max(0.05, 1 - blink)
            let eyeW = snapX(bodyW * 0.2)
            let eyeH = snapY(bodyH * 0.26 * eyeOpen)
            let eyeY = snapY(bodyY + bodyH * 0.56)
            let eyeOffset = snapX(bodyW * 0.24)

            context.cgContext.setFillColor(NSColor.labelColor.cgColor)

            context.cgContext.addPath(CGPath(
                roundedRect: CGRect(x: bodyX, y: bodyY, width: bodyW, height: bodyH),
                cornerWidth: bodyCorner,
                cornerHeight: bodyCorner,
                transform: nil))
            context.cgContext.addPath(CGPath(
                roundedRect: leftEarRect,
                cornerWidth: earCorner,
                cornerHeight: earCorner,
                transform: nil))
            context.cgContext.addPath(CGPath(
                roundedRect: rightEarRect,
                cornerWidth: earCorner,
                cornerHeight: earCorner,
                transform: nil))
            for i in 0..<4 {
                let x = legStartX + CGFloat(i) * (legW + legSpacing)
                let lift = (i % 2 == 0 ? legLift : -legLift)
                let rect = CGRect(
                    x: x,
                    y: legYBase + lift,
                    width: legW,
                    height: legH * (1 - 0.12 * legWiggle))
                context.cgContext.addPath(CGPath(
                    roundedRect: rect,
                    cornerWidth: legW * 0.34,
                    cornerHeight: legW * 0.34,
                    transform: nil))
            }
            context.cgContext.fillPath()

            context.cgContext.saveGState()
            context.cgContext.setBlendMode(CGBlendMode.clear)

            let leftCenter = CGPoint(x: snapX(w / 2 - eyeOffset), y: snapY(eyeY))
            let rightCenter = CGPoint(x: snapX(w / 2 + eyeOffset), y: snapY(eyeY))

            if earHoles || earScale > 1.05 {
                let holeW = snapX(earW * 0.6)
                let holeH = snapY(earH * 0.46)
                let holeCorner = snapX(holeW * 0.34)
                let leftHoleRect = CGRect(
                    x: snapX(leftEarRect.midX - holeW / 2),
                    y: snapY(leftEarRect.midY - holeH / 2 + earH * 0.04),
                    width: holeW,
                    height: holeH)
                let rightHoleRect = CGRect(
                    x: snapX(rightEarRect.midX - holeW / 2),
                    y: snapY(rightEarRect.midY - holeH / 2 + earH * 0.04),
                    width: holeW,
                    height: holeH)

                context.cgContext.addPath(CGPath(
                    roundedRect: leftHoleRect,
                    cornerWidth: holeCorner,
                    cornerHeight: holeCorner,
                    transform: nil))
                context.cgContext.addPath(CGPath(
                    roundedRect: rightHoleRect,
                    cornerWidth: holeCorner,
                    cornerHeight: holeCorner,
                    transform: nil))
            }

            let left = CGMutablePath()
            left.move(to: CGPoint(x: snapX(leftCenter.x - eyeW / 2), y: snapY(leftCenter.y - eyeH)))
            left.addLine(to: CGPoint(x: snapX(leftCenter.x + eyeW / 2), y: snapY(leftCenter.y)))
            left.addLine(to: CGPoint(x: snapX(leftCenter.x - eyeW / 2), y: snapY(leftCenter.y + eyeH)))
            left.closeSubpath()

            let right = CGMutablePath()
            right.move(to: CGPoint(x: snapX(rightCenter.x + eyeW / 2), y: snapY(rightCenter.y - eyeH)))
            right.addLine(to: CGPoint(x: snapX(rightCenter.x - eyeW / 2), y: snapY(rightCenter.y)))
            right.addLine(to: CGPoint(x: snapX(rightCenter.x + eyeW / 2), y: snapY(rightCenter.y + eyeH)))
            right.closeSubpath()

            context.cgContext.addPath(left)
            context.cgContext.addPath(right)
            context.cgContext.fillPath()
            context.cgContext.restoreGState()

            if let badge {
                self.drawBadge(
                    badge,
                    canvas: Canvas(w: w, h: h, snapX: snapX, snapY: snapY, context: context.cgContext))
            }
        } else {
            NSGraphicsContext.restoreGraphicsState()
            return NSImage(size: self.size)
        }

        let image = NSImage(size: size)
        image.addRepresentation(rep)
        image.isTemplate = true
        return image
    }

    private static func drawBadge(_ badge: Badge, canvas: Canvas) {
        let strength: CGFloat = switch badge.prominence {
        case .primary: 1.0
        case .secondary: 0.58
        case .overridden: 0.85
        }

        // Bigger, higher-contrast badge:
        // - Increase diameter so tool activity is noticeable.
        // - Draw a filled "puck", then knock out the symbol shape (transparent hole).
        //   This reads better in template-rendered menu bar icons than tiny monochrome glyphs.
        let diameter = canvas.snapX(canvas.w * 0.52 * (0.92 + 0.08 * strength)) // ~9–10pt on an 18pt canvas
        let margin = canvas.snapX(max(0.45, canvas.w * 0.03))
        let rect = CGRect(
            x: canvas.snapX(canvas.w - diameter - margin),
            y: canvas.snapY(margin),
            width: diameter,
            height: diameter)

        canvas.context.saveGState()
        canvas.context.setShouldAntialias(true)

        // Clear the underlying pixels so the badge stays readable over the critter.
        canvas.context.saveGState()
        canvas.context.setBlendMode(.clear)
        canvas.context.addEllipse(in: rect.insetBy(dx: -1.0, dy: -1.0))
        canvas.context.fillPath()
        canvas.context.restoreGState()

        let fillAlpha: CGFloat = min(1.0, 0.36 + 0.24 * strength)
        let strokeAlpha: CGFloat = min(1.0, 0.78 + 0.22 * strength)

        canvas.context.setFillColor(NSColor.labelColor.withAlphaComponent(fillAlpha).cgColor)
        canvas.context.addEllipse(in: rect)
        canvas.context.fillPath()

        canvas.context.setStrokeColor(NSColor.labelColor.withAlphaComponent(strokeAlpha).cgColor)
        canvas.context.setLineWidth(max(1.25, canvas.snapX(canvas.w * 0.075)))
        canvas.context.strokeEllipse(in: rect.insetBy(dx: 0.45, dy: 0.45))

        if let base = NSImage(systemSymbolName: badge.symbolName, accessibilityDescription: nil) {
            let pointSize = max(7.0, diameter * 0.82)
            let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .black)
            let symbol = base.withSymbolConfiguration(config) ?? base
            symbol.isTemplate = true

            let symbolRect = rect.insetBy(dx: diameter * 0.17, dy: diameter * 0.17)
            canvas.context.saveGState()
            canvas.context.setBlendMode(.clear)
            symbol.draw(
                in: symbolRect,
                from: .zero,
                operation: .sourceOver,
                fraction: 1,
                respectFlipped: true,
                hints: nil)
            canvas.context.restoreGState()
        }

        canvas.context.restoreGState()
    }
}
