import AppKit
import SwiftUI

struct CritterStatusLabel: View {
    var isPaused: Bool
    var isSleeping: Bool
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

    private var effectiveAnimationsEnabled: Bool {
        self.animationsEnabled && !self.isSleeping
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
                    guard self.effectiveAnimationsEnabled, !self.earBoostActive else {
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
                    guard self.effectiveAnimationsEnabled, !self.earBoostActive else { return }
                    self.blink()
                }
                .onChange(of: self.sendCelebrationTick) { _, _ in
                    guard self.effectiveAnimationsEnabled, !self.earBoostActive else { return }
                    self.wiggleLegs()
                }
                .onChange(of: self.animationsEnabled) { _, enabled in
                    if enabled, !self.isSleeping {
                        self.scheduleRandomTimers(from: Date())
                    } else {
                        self.resetMotion()
                    }
                }
                .onChange(of: self.isSleeping) { _, _ in
                    self.resetMotion()
                }
                .onChange(of: self.earBoostActive) { _, active in
                    if active {
                        self.resetMotion()
                    } else if self.effectiveAnimationsEnabled {
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
        (self.effectiveAnimationsEnabled ? 1 : 0) | (self.earBoostActive ? 2 : 0)
    }

    private func tick(_ now: Date) {
        guard self.effectiveAnimationsEnabled, !self.earBoostActive else {
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

        if self.isSleeping {
            return Image(nsImage: CritterIconRenderer.makeIcon(blink: 1, eyesClosedLines: true, badge: nil))
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
        if self.isSleeping { return false }
        switch self.gatewayStatus {
        case .failed, .stopped:
            return !self.isPaused
        case .starting, .running, .attachedExisting:
            return false
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
        let stepX: CGFloat
        let stepY: CGFloat
        let snapX: (CGFloat) -> CGFloat
        let snapY: (CGFloat) -> CGFloat
        let context: CGContext
    }

    private struct Geometry {
        let bodyRect: CGRect
        let bodyCorner: CGFloat
        let leftEarRect: CGRect
        let rightEarRect: CGRect
        let earCorner: CGFloat
        let earW: CGFloat
        let earH: CGFloat
        let legW: CGFloat
        let legH: CGFloat
        let legSpacing: CGFloat
        let legStartX: CGFloat
        let legYBase: CGFloat
        let legLift: CGFloat
        let legHeightScale: CGFloat
        let eyeW: CGFloat
        let eyeY: CGFloat
        let eyeOffset: CGFloat

        init(canvas: Canvas, legWiggle: CGFloat, earWiggle: CGFloat, earScale: CGFloat) {
            let w = canvas.w
            let h = canvas.h
            let snapX = canvas.snapX
            let snapY = canvas.snapY

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
            let legHeightScale = 1 - 0.12 * legWiggle

            let eyeW = snapX(bodyW * 0.2)
            let eyeY = snapY(bodyY + bodyH * 0.56)
            let eyeOffset = snapX(bodyW * 0.24)

            self.bodyRect = CGRect(x: bodyX, y: bodyY, width: bodyW, height: bodyH)
            self.bodyCorner = bodyCorner
            self.leftEarRect = leftEarRect
            self.rightEarRect = rightEarRect
            self.earCorner = earCorner
            self.earW = earW
            self.earH = earH
            self.legW = legW
            self.legH = legH
            self.legSpacing = legSpacing
            self.legStartX = legStartX
            self.legYBase = legYBase
            self.legLift = legLift
            self.legHeightScale = legHeightScale
            self.eyeW = eyeW
            self.eyeY = eyeY
            self.eyeOffset = eyeOffset
        }
    }

    private struct FaceOptions {
        let blink: CGFloat
        let earHoles: Bool
        let earScale: CGFloat
        let eyesClosedLines: Bool
    }

    static func makeIcon(
        blink: CGFloat,
        legWiggle: CGFloat = 0,
        earWiggle: CGFloat = 0,
        earScale: CGFloat = 1,
        earHoles: Bool = false,
        eyesClosedLines: Bool = false,
        badge: Badge? = nil) -> NSImage
    {
        guard let rep = self.makeBitmapRep() else {
            return NSImage(size: self.size)
        }
        rep.size = self.size

        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }

        guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
            return NSImage(size: self.size)
        }
        NSGraphicsContext.current = context
        context.imageInterpolation = .none
        context.cgContext.setShouldAntialias(false)

        let canvas = self.makeCanvas(for: rep, context: context)
        let geometry = Geometry(canvas: canvas, legWiggle: legWiggle, earWiggle: earWiggle, earScale: earScale)

        self.drawBody(in: canvas, geometry: geometry)
        let face = FaceOptions(
            blink: blink,
            earHoles: earHoles,
            earScale: earScale,
            eyesClosedLines: eyesClosedLines)
        self.drawFace(in: canvas, geometry: geometry, options: face)

        if let badge {
            self.drawBadge(badge, canvas: canvas)
        }

        let image = NSImage(size: size)
        image.addRepresentation(rep)
        image.isTemplate = true
        return image
    }

    private static func makeBitmapRep() -> NSBitmapImageRep? {
        // Force a 36×36px backing store (2× for the 18pt logical canvas) so the menu bar icon stays crisp on Retina.
        let pixelsWide = 36
        let pixelsHigh = 36
        return NSBitmapImageRep(
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
    }

    private static func makeCanvas(for rep: NSBitmapImageRep, context: NSGraphicsContext) -> Canvas {
        let stepX = self.size.width / max(CGFloat(rep.pixelsWide), 1)
        let stepY = self.size.height / max(CGFloat(rep.pixelsHigh), 1)
        let snapX: (CGFloat) -> CGFloat = { ($0 / stepX).rounded() * stepX }
        let snapY: (CGFloat) -> CGFloat = { ($0 / stepY).rounded() * stepY }

        let w = snapX(size.width)
        let h = snapY(size.height)

        return Canvas(
            w: w,
            h: h,
            stepX: stepX,
            stepY: stepY,
            snapX: snapX,
            snapY: snapY,
            context: context.cgContext)
    }

    private static func drawBody(in canvas: Canvas, geometry: Geometry) {
        canvas.context.setFillColor(NSColor.labelColor.cgColor)

        canvas.context.addPath(CGPath(
            roundedRect: geometry.bodyRect,
            cornerWidth: geometry.bodyCorner,
            cornerHeight: geometry.bodyCorner,
            transform: nil))
        canvas.context.addPath(CGPath(
            roundedRect: geometry.leftEarRect,
            cornerWidth: geometry.earCorner,
            cornerHeight: geometry.earCorner,
            transform: nil))
        canvas.context.addPath(CGPath(
            roundedRect: geometry.rightEarRect,
            cornerWidth: geometry.earCorner,
            cornerHeight: geometry.earCorner,
            transform: nil))

        for i in 0..<4 {
            let x = geometry.legStartX + CGFloat(i) * (geometry.legW + geometry.legSpacing)
            let lift = i % 2 == 0 ? geometry.legLift : -geometry.legLift
            let rect = CGRect(
                x: x,
                y: geometry.legYBase + lift,
                width: geometry.legW,
                height: geometry.legH * geometry.legHeightScale)
            canvas.context.addPath(CGPath(
                roundedRect: rect,
                cornerWidth: geometry.legW * 0.34,
                cornerHeight: geometry.legW * 0.34,
                transform: nil))
        }
        canvas.context.fillPath()
    }

    private static func drawFace(
        in canvas: Canvas,
        geometry: Geometry,
        options: FaceOptions)
    {
        canvas.context.saveGState()
        canvas.context.setBlendMode(.clear)

        let leftCenter = CGPoint(
            x: canvas.snapX(canvas.w / 2 - geometry.eyeOffset),
            y: canvas.snapY(geometry.eyeY))
        let rightCenter = CGPoint(
            x: canvas.snapX(canvas.w / 2 + geometry.eyeOffset),
            y: canvas.snapY(geometry.eyeY))

        if options.earHoles || options.earScale > 1.05 {
            let holeW = canvas.snapX(geometry.earW * 0.6)
            let holeH = canvas.snapY(geometry.earH * 0.46)
            let holeCorner = canvas.snapX(holeW * 0.34)
            let leftHoleRect = CGRect(
                x: canvas.snapX(geometry.leftEarRect.midX - holeW / 2),
                y: canvas.snapY(geometry.leftEarRect.midY - holeH / 2 + geometry.earH * 0.04),
                width: holeW,
                height: holeH)
            let rightHoleRect = CGRect(
                x: canvas.snapX(geometry.rightEarRect.midX - holeW / 2),
                y: canvas.snapY(geometry.rightEarRect.midY - holeH / 2 + geometry.earH * 0.04),
                width: holeW,
                height: holeH)

            canvas.context.addPath(CGPath(
                roundedRect: leftHoleRect,
                cornerWidth: holeCorner,
                cornerHeight: holeCorner,
                transform: nil))
            canvas.context.addPath(CGPath(
                roundedRect: rightHoleRect,
                cornerWidth: holeCorner,
                cornerHeight: holeCorner,
                transform: nil))
        }

        if options.eyesClosedLines {
            let lineW = canvas.snapX(geometry.eyeW * 0.95)
            let lineH = canvas.snapY(max(canvas.stepY * 2, geometry.bodyRect.height * 0.06))
            let corner = canvas.snapX(lineH * 0.6)
            let leftRect = CGRect(
                x: canvas.snapX(leftCenter.x - lineW / 2),
                y: canvas.snapY(leftCenter.y - lineH / 2),
                width: lineW,
                height: lineH)
            let rightRect = CGRect(
                x: canvas.snapX(rightCenter.x - lineW / 2),
                y: canvas.snapY(rightCenter.y - lineH / 2),
                width: lineW,
                height: lineH)
            canvas.context.addPath(CGPath(
                roundedRect: leftRect,
                cornerWidth: corner,
                cornerHeight: corner,
                transform: nil))
            canvas.context.addPath(CGPath(
                roundedRect: rightRect,
                cornerWidth: corner,
                cornerHeight: corner,
                transform: nil))
        } else {
            let eyeOpen = max(0.05, 1 - options.blink)
            let eyeH = canvas.snapY(geometry.bodyRect.height * 0.26 * eyeOpen)

            let left = CGMutablePath()
            left.move(to: CGPoint(
                x: canvas.snapX(leftCenter.x - geometry.eyeW / 2),
                y: canvas.snapY(leftCenter.y - eyeH)))
            left.addLine(to: CGPoint(
                x: canvas.snapX(leftCenter.x + geometry.eyeW / 2),
                y: canvas.snapY(leftCenter.y)))
            left.addLine(to: CGPoint(
                x: canvas.snapX(leftCenter.x - geometry.eyeW / 2),
                y: canvas.snapY(leftCenter.y + eyeH)))
            left.closeSubpath()

            let right = CGMutablePath()
            right.move(to: CGPoint(
                x: canvas.snapX(rightCenter.x + geometry.eyeW / 2),
                y: canvas.snapY(rightCenter.y - eyeH)))
            right.addLine(to: CGPoint(
                x: canvas.snapX(rightCenter.x - geometry.eyeW / 2),
                y: canvas.snapY(rightCenter.y)))
            right.addLine(to: CGPoint(
                x: canvas.snapX(rightCenter.x + geometry.eyeW / 2),
                y: canvas.snapY(rightCenter.y + eyeH)))
            right.closeSubpath()

            canvas.context.addPath(left)
            canvas.context.addPath(right)
        }

        canvas.context.fillPath()
        canvas.context.restoreGState()
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

#if DEBUG
@MainActor
extension CritterStatusLabel {
    static func exerciseForTesting() async {
        var label = CritterStatusLabel(
            isPaused: false,
            isSleeping: false,
            isWorking: true,
            earBoostActive: false,
            blinkTick: 1,
            sendCelebrationTick: 1,
            gatewayStatus: .running(details: nil),
            animationsEnabled: true,
            iconState: .workingMain(.tool(.bash)))

        _ = label.body
        _ = label.iconImage
        _ = label.tickTaskID
        label.tick(Date())
        label.resetMotion()
        label.blink()
        label.wiggle()
        label.wiggleLegs()
        label.wiggleEars()
        label.scurry()
        label.scheduleRandomTimers(from: Date())
        _ = label.gatewayNeedsAttention
        _ = label.gatewayBadgeColor

        label.isPaused = true
        _ = label.iconImage

        label.isPaused = false
        label.isSleeping = true
        _ = label.iconImage

        label.isSleeping = false
        label.iconState = .idle
        _ = label.iconImage

        let failed = CritterStatusLabel(
            isPaused: false,
            isSleeping: false,
            isWorking: false,
            earBoostActive: false,
            blinkTick: 0,
            sendCelebrationTick: 0,
            gatewayStatus: .failed("boom"),
            animationsEnabled: false,
            iconState: .idle)
        _ = failed.gatewayNeedsAttention
        _ = failed.gatewayBadgeColor

        let stopped = CritterStatusLabel(
            isPaused: false,
            isSleeping: false,
            isWorking: false,
            earBoostActive: false,
            blinkTick: 0,
            sendCelebrationTick: 0,
            gatewayStatus: .stopped,
            animationsEnabled: false,
            iconState: .idle)
        _ = stopped.gatewayNeedsAttention
        _ = stopped.gatewayBadgeColor

        _ = CritterIconRenderer.makeIcon(
            blink: 0.6,
            legWiggle: 0.8,
            earWiggle: 0.4,
            earScale: 1.4,
            earHoles: true,
            eyesClosedLines: true,
            badge: .init(symbolName: "gearshape.fill", prominence: .secondary))
    }
}
#endif
