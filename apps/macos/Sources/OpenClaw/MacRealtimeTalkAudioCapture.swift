@preconcurrency import AVFoundation
import CoreAudio
import Foundation
import OpenClawKit
import OSLog

@MainActor
final class MacRealtimeTalkAudioCapture: RealtimeTalkAudioCapturing {
    private static let frameBufferSize: AVAudioFrameCount = 2048

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.realtime.capture")
    private let selectedInputUID: @MainActor () -> String?
    private var deliveryGate = TalkGenerationDeliveryGate()
    private var captureRouteState: MacRealtimeTalkCaptureRouteState?

    private var graph: MacRealtimeTalkAudioGraph?
    private var configurationObserver: NSObjectProtocol?
    lazy var pcmPlayer = RealtimePCMStreamingAudioPlayer(
        preparePlayback: { [weak self] sampleRate in
            guard let graph = self?.graph else { throw MacRealtimeTalkAudioCaptureError.inputUnavailable }
            try graph.preparePlayback(sampleRate: sampleRate)
        },
        scheduleFrame: { [weak self] data, _, completion in
            guard let graph = self?.graph else { throw MacRealtimeTalkAudioCaptureError.inputUnavailable }
            try graph.schedule(data, completion: completion)
        },
        scheduleDrain: { [weak self] _, completion in
            guard let graph = self?.graph else { throw MacRealtimeTalkAudioCaptureError.inputUnavailable }
            try graph.schedule(
                Data(repeating: 0, count: MemoryLayout<Int16>.size),
                callbackType: .dataPlayedBack,
                completion: completion)
        },
        stopPlayback: { [weak self] in self?.graph?.player.stop() },
        playbackTime: { [weak self] in self?.graph?.playbackTime })
    private var audioInputObserver: AudioInputDeviceObserver?
    private var audioOutputObserver: MacRealtimeTalkOutputRouteObserver?
    private var activeInputResolution: AudioInputDeviceResolution?
    private var onFailure: (@MainActor (String) -> Void)?
    private var tapInstalled = false
    private var outputRouteDecisionState = MacRealtimeTalkOutputRouteDecisionState()
    private var outputRouteObservationGeneration: UInt64 = 0
    #if DEBUG
    private var testOutputRouteCallbackHandled: (@Sendable () -> Void)?
    #endif

    var usesServerVADForBargeIn: Bool {
        self.outputRouteDecisionState.inputPolicy(hasEchoControl: self.graph?.hasEchoControl == true)
            .usesServerVADForBargeIn
    }

    var suppressesInputDuringOutput: Bool {
        self.outputRouteDecisionState.inputPolicy(hasEchoControl: self.graph?.hasEchoControl == true)
            .suppressesInputDuringOutput
    }

    init(selectedInputUID: @escaping @MainActor () -> String? = {
        AppStateStore.shared.voiceWakeMicID
    }) {
        self.selectedInputUID = selectedInputUID
    }

    @MainActor deinit {
        self.stop()
    }

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @MainActor (String) -> Void) throws
    {
        guard targetSampleRate.isFinite, targetSampleRate > 0 else {
            throw MacRealtimeTalkAudioCaptureError.invalidTargetSampleRate
        }

        self.stop()
        self.onFailure = onFailure
        self.startOutputRouteObserver()
        do {
            try self.startCaptureEngine(targetSampleRate: targetSampleRate, onAudio: onAudio)
            self.startDeviceObserver()
        } catch {
            self.stop()
            throw error
        }
    }

    func stop() {
        // Close delivery before removing the tap. A callback already running on Core Audio's
        // queue must finish before stop returns, and later callbacks must drop their frames.
        self.deliveryGate.deactivate()
        self.audioInputObserver?.stop()
        self.audioInputObserver = nil
        self.retireOutputRouteObserver()
        self.teardownEngine()
        self.onFailure = nil
    }

    func stopInputPreservingPlayback() -> Bool {
        guard let graph else { return false }
        // Hardware I/O remains alive for final playback; microphone delivery does not.
        self.deliveryGate.deactivate()
        if self.tapInstalled {
            graph.input.removeTap(onBus: 0)
        }
        self.tapInstalled = false
        graph.echoPipeline?.stop()
        if graph.renderTapInstalled {
            graph.engine.mainMixerNode.removeTap(onBus: 0)
            graph.renderTapInstalled = false
        }
        graph.echoPipeline = nil
        return true
    }

    private func startCaptureEngine(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void) throws
    {
        let selection = AudioInputDeviceObserver.resolveSelection(self.selectedInputUID())
        // AVAudioEngine materializes inputNode from the system default before CurrentDevice can bind.
        // Without a usable default, accessing inputNode can SIGABRT even when another UID is alive.
        guard selection.resolvedUID != nil, AudioInputDeviceObserver.hasUsableDefaultInputDevice() else {
            throw MacRealtimeTalkAudioCaptureError.inputUnavailable
        }

        try self.configureEngine(selection: selection, targetSampleRate: targetSampleRate, onAudio: onAudio)
    }

    private func configureEngine(
        selection: AudioInputDeviceResolution,
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void) throws
    {
        let graph = try MacRealtimeTalkAudioGraph(
            sampleRate: targetSampleRate,
            inputProcessingMode: self.captureRouteState?.mode ?? .echoControlled)
        self.graph = graph
        let engine = graph.engine
        let input = graph.input
        // The shared I/O graph already uses the system default. Rebinding it
        // unnecessarily can disturb playback before echo capture starts.
        let activeResolution = selection.resolvedUID == AudioInputDeviceObserver.defaultInputDeviceUID()
            ? selection
            : AudioInputDeviceObserver.bindSelectedInputIfNeeded(
                selection, to: input, logger: self.logger, context: "realtime")
        guard let selectedUID = activeResolution.resolvedUID else {
            throw MacRealtimeTalkAudioCaptureError.inputUnavailable
        }
        let format = input.outputFormat(forBus: 0)
        guard format.commonFormat == .pcmFormatFloat32, !format.isInterleaved,
              format.channelCount > 0, format.sampleRate > 0
        else {
            throw MacRealtimeTalkAudioCaptureError.invalidInputFormat
        }
        let inputChannels = try MacRealtimeTalkInputChannels.resolve(input: input, selectedInputUID: selectedUID)
        guard let deliveryToken = self.captureRouteState?.activate(for: graph.inputProcessingMode) else {
            throw MacRealtimeTalkAudioCaptureError.inputUnavailable
        }
        let engineID = ObjectIdentifier(engine)
        let pipeline = try MacRealtimeTalkEchoPipeline(
            inputProcessingMode: graph.inputProcessingMode,
            targetSampleRate: targetSampleRate,
            deliveryGate: self.deliveryGate,
            deliveryToken: deliveryToken,
            onAudio: onAudio,
            onFailure: { [weak self] in
                Task { @MainActor [weak self] in
                    guard let self, self.graph.map({ ObjectIdentifier($0.engine) }) == engineID else { return }
                    self
                        .failCapture(
                            String(localized: "Realtime echo control lost its playback reference. Reconnecting…"))
                }
            })
        graph.echoPipeline = pipeline
        input.installTap(
            onBus: 0,
            bufferSize: Self.frameBufferSize,
            format: format,
            block: pipeline.makeTap(channels: inputChannels, isRender: false))
        self.tapInstalled = true
        if graph.inputProcessingMode == .echoControlled {
            let renderFormat = engine.mainMixerNode.outputFormat(forBus: 0)
            engine.mainMixerNode.installTap(
                onBus: 0,
                bufferSize: Self.frameBufferSize,
                format: renderFormat,
                block: pipeline.makeTap(channels: 0..<Int(renderFormat.channelCount), isRender: true))
            graph.renderTapInstalled = true
        }
        engine.prepare()
        try engine.start()
        guard try MacRealtimeTalkInputChannels.resolve(input: input, selectedInputUID: selectedUID) == inputChannels
        else {
            throw MacRealtimeTalkInputChannels.MappingError.unsupportedChannelMap
        }
        self.activeInputResolution = activeResolution
        if graph.inputProcessingMode == .echoControlled {
            self.logger.info("realtime shared audio started; waiting for software echo reference")
        } else {
            self.logger.info("realtime shared audio started with isolated headphone input")
        }
        self.configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil)
        { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.graph.map({ ObjectIdentifier($0.engine) }) == engineID else { return }
                self.failCapture(String(localized: "Realtime audio route changed. Reconnecting…"))
            }
        }
    }

    private func startDeviceObserver() {
        let observer = AudioInputDeviceObserver()
        observer.start { [weak self] in
            Task { @MainActor [weak self] in
                self?.audioInputDevicesDidChange()
            }
        }
        self.audioInputObserver = observer
    }

    private func startOutputRouteObserver() {
        let observer = MacRealtimeTalkOutputRouteObserver()
        let onChange = self.replaceOutputRouteObserver(observer)
        let initialRoute = observer.start(onChange: onChange)
        // Listener installation can poison an otherwise isolated route. Use the
        // observed result synchronously before graph construction starts I/O.
        self.updateOutputRoute(initialRoute)
    }

    private func replaceOutputRouteObserver(
        _ observer: MacRealtimeTalkOutputRouteObserver) -> @Sendable (MacRealtimeTalkOutputRoute?) -> Void
    {
        self.outputRouteObservationGeneration &+= 1
        let generation = self.outputRouteObservationGeneration
        self.deliveryGate.deactivate()
        self.deliveryGate = TalkGenerationDeliveryGate()
        let routeState = MacRealtimeTalkCaptureRouteState(deliveryGate: self.deliveryGate)
        self.captureRouteState = routeState
        self.audioOutputObserver = observer
        #if DEBUG
        let onHandled = self.testOutputRouteCallbackHandled
        self.testOutputRouteCallbackHandled = nil
        #endif
        return { [weak self, observerID = ObjectIdentifier(observer)] route in
            // Close this capture's gate on the observer's queue before an async
            // MainActor hop can let headphone input escape onto a speaker route.
            routeState.update(route: route)
            Task { @MainActor [weak self] in
                #if DEBUG
                defer { onHandled?() }
                #endif
                guard let self,
                      generation == self.outputRouteObservationGeneration,
                      self.audioOutputObserver.map(ObjectIdentifier.init) == observerID
                else { return }
                self.updateOutputRoute(route)
            }
        }
    }

    private func retireOutputRouteObserver() {
        self.outputRouteObservationGeneration &+= 1
        self.audioOutputObserver?.stop()
        self.audioOutputObserver = nil
        self.captureRouteState = nil
        self.outputRouteDecisionState.reset()
    }

    private func updateOutputRoute(_ route: MacRealtimeTalkOutputRoute?) {
        guard let decision = self.outputRouteDecisionState.update(route: route) else { return }
        self.logger.info(
            "realtime output route decision \(decision.redactedDescription, privacy: .public)")
        if let graph, graph.inputProcessingMode != decision.inputProcessingMode {
            self.failCapture(String(localized: "Realtime audio route changed. Reconnecting…"))
        }
    }

    private func audioInputDevicesDidChange() {
        guard self.graph != nil else { return }
        let desiredResolution = AudioInputDeviceObserver.resolveSelection(self.selectedInputUID())
        guard desiredResolution != self.activeInputResolution ||
            self.activeInputResolution?.shouldRestart(
                availableUIDs: AudioInputDeviceObserver.aliveInputDeviceUIDs(),
                defaultUID: AudioInputDeviceObserver.defaultInputDeviceUID()) == true
        else { return }

        // Capture and playback share I/O. A microphone-only restart would stop
        // the player beneath an active relay output; retire the whole session.
        self.failCapture(String(localized: "Realtime audio route changed. Reconnecting…"))
    }

    private func failCapture(_ message: String) {
        let onFailure = self.onFailure
        self.stop()
        onFailure?(message)
    }

    private func teardownEngine() {
        if let observer = self.configurationObserver {
            NotificationCenter.default.removeObserver(observer)
            self.configurationObserver = nil
        }
        if self.tapInstalled, let graph {
            graph.input.removeTap(onBus: 0)
        }
        self.tapInstalled = false
        _ = self.pcmPlayer.stop()
        self.graph?.stop()
        self.graph = nil
        self.activeInputResolution = nil
    }

    #if DEBUG
    func _test_replaceOutputRouteObserver()
        -> (
            callback: @Sendable (MacRealtimeTalkOutputRoute?) -> Void,
            handled: AsyncStream<Void>)
    {
        let handled = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.testOutputRouteCallbackHandled = {
            handled.continuation.yield()
            handled.continuation.finish()
        }
        return (self.replaceOutputRouteObserver(MacRealtimeTalkOutputRouteObserver()), handled.stream)
    }
    #endif
}

struct MacRealtimeTalkOutputRoute: Equatable, Sendable {
    let transportType: UInt32
    let terminalTypes: [UInt32]
    let selectedDataSource: MacRealtimeTalkOutputDataSource
}

enum MacRealtimeTalkOutputDataSource: Equatable, Sendable {
    case unsupported
    case failed
    case selected(kinds: [UInt32])
}

enum MacRealtimeTalkOutputRouteDecisionReason: String, Sendable {
    case routeUnavailable = "route-unavailable"
    case dataSourceReadFailed = "data-source-read-failed"
    case transportNotAllowlisted = "transport-not-allowlisted"
    case outputKindUnavailable = "output-kind-unavailable"
    case outputKindNotHeadphones = "output-kind-not-headphones"
    case isolatedHeadphones = "isolated-headphones"
}

struct MacRealtimeTalkOutputRouteDecision: Equatable, Sendable {
    let suppressesInputDuringOutput: Bool
    let reason: MacRealtimeTalkOutputRouteDecisionReason
    let transportType: UInt32?
    let effectiveKinds: [UInt32]
    let selectedDataSource: MacRealtimeTalkOutputDataSource?

    var inputProcessingMode: MacRealtimeTalkInputProcessingMode {
        self.suppressesInputDuringOutput ? .echoControlled : .isolatedHeadphones
    }

    var redactedDescription: String {
        let transport = self.transportType.map(MacRealtimeTalkFourCC.describe) ?? "unavailable"
        let kinds = MacRealtimeTalkFourCC.describe(self.effectiveKinds)
        let source = switch self.selectedDataSource {
        case .unsupported:
            "unsupported"
        case .failed:
            "failed"
        case let .selected(sourceKinds):
            Self.selectedDataSourceTag(sourceKinds)
        case nil:
            "unavailable"
        }
        return "transport=\(transport) kinds=\(kinds) source=\(source) " +
            "suppression=\(self.suppressesInputDuringOutput) reason=\(self.reason.rawValue)"
    }

    private static func selectedDataSourceTag(_ kinds: [UInt32]) -> String {
        "selected:" + MacRealtimeTalkFourCC.describe(kinds)
    }
}

enum MacRealtimeTalkOutputRoutePolicy {
    static func decision(
        for route: MacRealtimeTalkOutputRoute?) -> MacRealtimeTalkOutputRouteDecision
    {
        guard let route else {
            return MacRealtimeTalkOutputRouteDecision(
                suppressesInputDuringOutput: true,
                reason: .routeUnavailable,
                transportType: nil,
                effectiveKinds: [],
                selectedDataSource: nil)
        }

        if route.selectedDataSource == .failed {
            return self.decision(
                route: route,
                effectiveKinds: [],
                suppressesInput: true,
                reason: .dataSourceReadFailed)
        }

        // The selected source is the active routing fact. Stream terminals are only a
        // fallback for devices that expose no data-source property.
        let effectiveKinds: [UInt32] = switch route.selectedDataSource {
        case .unsupported:
            route.terminalTypes.sorted()
        case let .selected(kinds):
            kinds.sorted()
        case .failed:
            []
        }
        let allowlistedTransports: Set<UInt32> = [
            kAudioDeviceTransportTypeBuiltIn,
            kAudioDeviceTransportTypeUSB,
            kAudioDeviceTransportTypeBluetooth,
            kAudioDeviceTransportTypeBluetoothLE,
        ]
        guard allowlistedTransports.contains(route.transportType) else {
            return self.decision(
                route: route,
                effectiveKinds: effectiveKinds,
                suppressesInput: true,
                reason: .transportNotAllowlisted)
        }

        guard !effectiveKinds.isEmpty else {
            return self.decision(
                route: route,
                effectiveKinds: [],
                suppressesInput: true,
                reason: .outputKindUnavailable)
        }
        guard effectiveKinds.allSatisfy({ $0 == kAudioStreamTerminalTypeHeadphones }) else {
            return self.decision(
                route: route,
                effectiveKinds: effectiveKinds,
                suppressesInput: true,
                reason: .outputKindNotHeadphones)
        }
        return self.decision(
            route: route,
            effectiveKinds: effectiveKinds,
            suppressesInput: false,
            reason: .isolatedHeadphones)
    }

    private static func decision(
        route: MacRealtimeTalkOutputRoute,
        effectiveKinds: [UInt32],
        suppressesInput: Bool,
        reason: MacRealtimeTalkOutputRouteDecisionReason) -> MacRealtimeTalkOutputRouteDecision
    {
        let selectedDataSource = switch route.selectedDataSource {
        case .unsupported:
            MacRealtimeTalkOutputDataSource.unsupported
        case .failed:
            MacRealtimeTalkOutputDataSource.failed
        case let .selected(kinds):
            MacRealtimeTalkOutputDataSource.selected(kinds: kinds.sorted())
        }
        return MacRealtimeTalkOutputRouteDecision(
            suppressesInputDuringOutput: suppressesInput,
            reason: reason,
            transportType: route.transportType,
            effectiveKinds: effectiveKinds,
            selectedDataSource: selectedDataSource)
    }
}

/// Each observation owns one capture gate; a retired observer cannot close its successor.
final class MacRealtimeTalkCaptureRouteState: @unchecked Sendable {
    private let lock = NSLock()
    private let deliveryGate: TalkGenerationDeliveryGate
    private var observedMode: MacRealtimeTalkInputProcessingMode?
    private var retired = false

    init(deliveryGate: TalkGenerationDeliveryGate) {
        self.deliveryGate = deliveryGate
    }

    var mode: MacRealtimeTalkInputProcessingMode {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.observedMode ?? .echoControlled
    }

    func activate(for mode: MacRealtimeTalkInputProcessingMode) -> UInt64? {
        self.lock.lock()
        defer { self.lock.unlock() }
        guard !self.retired, self.observedMode == mode else { return nil }
        return self.deliveryGate.activate()
    }

    func update(route: MacRealtimeTalkOutputRoute?) {
        let next = MacRealtimeTalkOutputRoutePolicy.decision(for: route).inputProcessingMode
        self.lock.lock()
        defer { self.lock.unlock() }
        if let previous = self.observedMode, previous != next {
            self.retired = true
            self.deliveryGate.deactivate()
        }
        self.observedMode = next
    }
}

struct MacRealtimeTalkOutputRouteDecisionState {
    private(set) var current: MacRealtimeTalkOutputRouteDecision?

    func inputPolicy(hasEchoControl: Bool)
        -> (suppressesInputDuringOutput: Bool, usesServerVADForBargeIn: Bool)
    {
        let needsEchoControl = self.current?.suppressesInputDuringOutput ?? true
        // Isolated headphones retain local interruption even when the gateway
        // disables server VAD interruption for forced agent consultation.
        return (needsEchoControl && !hasEchoControl, needsEchoControl && hasEchoControl)
    }

    mutating func update(route: MacRealtimeTalkOutputRoute?) -> MacRealtimeTalkOutputRouteDecision? {
        let next = MacRealtimeTalkOutputRoutePolicy.decision(for: route)
        guard next != self.current else { return nil }
        self.current = next
        return next
    }

    mutating func reset() {
        self.current = nil
    }
}

private enum MacRealtimeTalkFourCC {
    static func describe(_ values: [UInt32]) -> String {
        "[" + values.map(self.describe).joined(separator: ",") + "]"
    }

    static func describe(_ value: UInt32) -> String {
        let bytes = [
            UInt8((value >> 24) & 0xFF),
            UInt8((value >> 16) & 0xFF),
            UInt8((value >> 8) & 0xFF),
            UInt8(value & 0xFF),
        ]
        guard bytes.allSatisfy({ (0x20...0x7E).contains($0) }) else {
            return String(format: "0x%08X", value)
        }
        return "'\(String(bytes: bytes, encoding: .ascii) ?? "????")'"
    }
}

private struct MacRealtimeTalkAudioPropertyObservation {
    let objectID: AudioObjectID
    let address: AudioObjectPropertyAddress
    let listener: AudioObjectPropertyListenerBlock

    init?(
        objectID: AudioObjectID,
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        listener: @escaping AudioObjectPropertyListenerBlock)
    {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectAddPropertyListenerBlock(
            objectID,
            &address,
            DispatchQueue.main,
            listener) == noErr
        else { return nil }
        self.objectID = objectID
        self.address = address
        self.listener = listener
    }

    func stop() {
        var address = self.address
        _ = AudioObjectRemovePropertyListenerBlock(
            self.objectID,
            &address,
            DispatchQueue.main,
            self.listener)
    }
}

final class MacRealtimeTalkOutputRouteObserver: @unchecked Sendable {
    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.realtime.output-route")
    private var defaultOutputObservation: MacRealtimeTalkAudioPropertyObservation?
    private var dataSourceObservation: MacRealtimeTalkAudioPropertyObservation?
    private var warningReported = false
    private var currentRouteSnapshot: MacRealtimeTalkOutputRoute?

    @discardableResult
    func start(onChange: @escaping @Sendable (MacRealtimeTalkOutputRoute?) -> Void) -> MacRealtimeTalkOutputRoute? {
        guard self.defaultOutputObservation == nil else { return self.currentRouteSnapshot }
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            _ = self?.bindCurrentOutput(onChange: onChange)
        }
        guard let observation = MacRealtimeTalkAudioPropertyObservation(
            objectID: AudioObjectID(kAudioObjectSystemObject),
            selector: kAudioHardwarePropertyDefaultOutputDevice,
            scope: kAudioObjectPropertyScopeGlobal,
            listener: listener)
        else {
            self.reportWarningOnce("default-output-listener-failed")
            return self.publish(nil, onChange: onChange)
        }
        self.defaultOutputObservation = observation
        return self.bindCurrentOutput(onChange: onChange)
    }

    func stop() {
        self.defaultOutputObservation?.stop()
        self.defaultOutputObservation = nil
        self.dataSourceObservation?.stop()
        self.dataSourceObservation = nil
        self.currentRouteSnapshot = nil
    }

    private func publish(
        _ route: MacRealtimeTalkOutputRoute?,
        onChange: @Sendable (MacRealtimeTalkOutputRoute?) -> Void) -> MacRealtimeTalkOutputRoute?
    {
        self.currentRouteSnapshot = route
        onChange(route)
        return route
    }

    private func bindCurrentOutput(
        onChange: @escaping @Sendable (MacRealtimeTalkOutputRoute?) -> Void) -> MacRealtimeTalkOutputRoute?
    {
        self.dataSourceObservation?.stop()
        self.dataSourceObservation = nil
        guard let deviceID = Self.defaultOutputDeviceID() else {
            self.reportWarningOnce("default-output-read-failed")
            return self.publish(nil, onChange: onChange)
        }
        guard let route = Self.currentRoute(deviceID: deviceID) else {
            self.reportWarningOnce("output-route-read-failed")
            return self.publish(nil, onChange: onChange)
        }
        if route.selectedDataSource == .failed {
            self.reportWarningOnce("data-source-read-failed")
        }
        guard Self.hasDataSourceProperty(deviceID: deviceID) else {
            return self.publish(route, onChange: onChange)
        }
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            guard let refreshedRoute = Self.currentRoute(deviceID: deviceID) else {
                self.reportWarningOnce("output-route-read-failed")
                _ = self.publish(nil, onChange: onChange)
                return
            }
            if refreshedRoute.selectedDataSource == .failed {
                self.reportWarningOnce("data-source-read-failed")
            }
            _ = self.publish(refreshedRoute, onChange: onChange)
        }
        guard let observation = MacRealtimeTalkAudioPropertyObservation(
            objectID: deviceID,
            selector: kAudioDevicePropertyDataSource,
            scope: kAudioDevicePropertyScopeOutput,
            listener: listener)
        else {
            // A supported source can change without the device ID changing. If it cannot
            // be observed, poison the route so the suppression policy remains fail-closed.
            self.reportWarningOnce("data-source-listener-failed")
            return self.publish(MacRealtimeTalkOutputRoute(
                transportType: route.transportType,
                terminalTypes: route.terminalTypes,
                selectedDataSource: .failed), onChange: onChange)
        }
        self.dataSourceObservation = observation
        return self.publish(route, onChange: onChange)
    }

    private static func currentRoute(deviceID: AudioObjectID) -> MacRealtimeTalkOutputRoute? {
        guard let transportType = uint32Property(
            objectID: deviceID,
            selector: kAudioDevicePropertyTransportType,
            scope: kAudioObjectPropertyScopeGlobal)
        else { return nil }

        let terminalTypes = self.outputTerminalTypes(deviceID: deviceID)
        return MacRealtimeTalkOutputRoute(
            transportType: transportType,
            terminalTypes: terminalTypes,
            selectedDataSource: self.selectedDataSource(deviceID: deviceID))
    }

    private static func defaultOutputDeviceID() -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var deviceID = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &deviceID)
        return status == noErr && deviceID != 0 ? deviceID : nil
    }

    private static func outputTerminalTypes(deviceID: AudioObjectID) -> [UInt32] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size) == noErr,
              size > 0,
              Int(size) % MemoryLayout<AudioStreamID>.size == 0
        else { return [] }

        var streamIDs = [AudioStreamID](
            repeating: 0,
            count: Int(size) / MemoryLayout<AudioStreamID>.size)
        guard AudioObjectGetPropertyData(
            deviceID,
            &address,
            0,
            nil,
            &size,
            &streamIDs) == noErr
        else { return [] }

        var terminalTypes: [UInt32] = []
        terminalTypes.reserveCapacity(streamIDs.count)
        for streamID in streamIDs {
            guard let terminalType = self.uint32Property(
                objectID: streamID,
                selector: kAudioStreamPropertyTerminalType,
                scope: kAudioObjectPropertyScopeGlobal)
            else { return [] }
            terminalTypes.append(terminalType)
        }
        return terminalTypes
    }

    private static func hasDataSourceProperty(deviceID: AudioObjectID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDataSource,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        return AudioObjectHasProperty(deviceID, &address)
    }

    private static func selectedDataSource(
        deviceID: AudioObjectID) -> MacRealtimeTalkOutputDataSource
    {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDataSource,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectHasProperty(deviceID, &address) else { return .unsupported }

        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size) == noErr,
              size > 0,
              Int(size) % MemoryLayout<UInt32>.size == 0
        else { return .failed }

        var sourceIDs = [UInt32](
            repeating: 0,
            count: Int(size) / MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(
            deviceID,
            &address,
            0,
            nil,
            &size,
            &sourceIDs) == noErr,
            !sourceIDs.isEmpty
        else { return .failed }

        var kinds: [UInt32] = []
        kinds.reserveCapacity(sourceIDs.count)
        for sourceID in sourceIDs {
            guard let kind = self.dataSourceKind(deviceID: deviceID, sourceID: sourceID)
            else { return .failed }
            kinds.append(kind)
        }
        return .selected(kinds: kinds)
    }

    private static func dataSourceKind(
        deviceID: AudioObjectID,
        sourceID: UInt32) -> UInt32?
    {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDataSourceKindForID,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        var input = sourceID
        var output: UInt32 = 0
        var status = kAudioHardwareUnspecifiedError
        withUnsafeMutablePointer(to: &input) { inputPointer in
            withUnsafeMutablePointer(to: &output) { outputPointer in
                var translation = AudioValueTranslation(
                    mInputData: UnsafeMutableRawPointer(inputPointer),
                    mInputDataSize: UInt32(MemoryLayout<UInt32>.size),
                    mOutputData: UnsafeMutableRawPointer(outputPointer),
                    mOutputDataSize: UInt32(MemoryLayout<UInt32>.size))
                var size = UInt32(MemoryLayout<AudioValueTranslation>.size)
                status = AudioObjectGetPropertyData(
                    deviceID,
                    &address,
                    0,
                    nil,
                    &size,
                    &translation)
            }
        }
        return status == noErr ? output : nil
    }

    private static func uint32Property(
        objectID: AudioObjectID,
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope) -> UInt32?
    {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(
            objectID,
            &address,
            0,
            nil,
            &size,
            &value)
        return status == noErr ? value : nil
    }

    private func reportWarningOnce(_ reason: String) {
        guard !self.warningReported else { return }
        self.warningReported = true
        self.logger.warning(
            "realtime output route observation degraded reason=\(reason, privacy: .public)")
    }
}

enum MacRealtimeTalkAudioCaptureError: LocalizedError {
    case invalidTargetSampleRate
    case inputUnavailable
    case outputUnavailable
    case invalidInputFormat

    var errorDescription: String? {
        switch self {
        case .invalidTargetSampleRate: String(localized: "Realtime Talk requested an invalid audio sample rate")
        case .inputUnavailable: String(localized: "Selected input and system default are unavailable")
        case .outputUnavailable: String(localized: "Realtime Talk audio output is unavailable")
        case .invalidInputFormat: String(localized: "Selected audio input has no usable Float32 format")
        }
    }
}

enum MacRealtimeTalkAudioFrameEncoder {
    nonisolated static func encode(
        buffer: AVAudioPCMBuffer,
        targetSampleRate: Double,
        timestampMs: Double) -> RealtimeTalkAudioFrame?
    {
        let inputSampleRate = buffer.format.sampleRate
        guard targetSampleRate.isFinite, targetSampleRate > 0
        else { return nil }
        let data = RealtimeTalkPCM16Encoder.encode(
            buffer: buffer,
            inputSampleRate: inputSampleRate,
            targetSampleRate: targetSampleRate)
        guard !data.isEmpty else { return nil }
        return RealtimeTalkAudioFrame(
            data: data,
            timestampMs: timestampMs,
            rms: Float(TalkAudioLevel.pcm16RMS(data)))
    }
}

final class TalkGenerationDeliveryGate: @unchecked Sendable {
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var active = true

    func activate() -> UInt64 {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.generation &+= 1
        self.active = true
        return self.generation
    }

    func deactivate() {
        self.lock.lock()
        self.generation &+= 1
        self.active = false
        self.lock.unlock()
    }

    @discardableResult
    func deactivate(ifActive generation: UInt64) -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        guard self.active, self.generation == generation else { return false }
        self.generation &+= 1
        self.active = false
        return true
    }

    func isActive(_ generation: UInt64) -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.active && self.generation == generation
    }

    @discardableResult
    func deliver(ifActive generation: UInt64, _ body: () -> Void) -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        guard self.active, self.generation == generation else { return false }
        body()
        return true
    }
}
