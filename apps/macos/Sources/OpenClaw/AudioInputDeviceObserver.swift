import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation
import OSLog

struct AudioInputDeviceDescriptor: Equatable, Identifiable, Sendable {
    let uid: String
    let name: String

    var id: String {
        self.uid
    }
}

struct AudioInputDeviceResolution: Equatable, Sendable {
    let selectedUID: String?
    let resolvedUID: String?
    let fellBackToSystemDefault: Bool

    var shouldBindSelectedDevice: Bool {
        self.selectedUID != nil && !self.fellBackToSystemDefault && self.resolvedUID != nil
    }

    func shouldRestart(availableUIDs: Set<String>, defaultUID: String?) -> Bool {
        guard let resolvedUID, availableUIDs.contains(resolvedUID) else { return true }
        guard self.selectedUID == nil || self.fellBackToSystemDefault else { return false }
        return defaultUID != resolvedUID
    }
}

enum AudioInputDeviceSelectionResolver {
    static func resolve(
        selectedUID: String?,
        availableUIDs: Set<String>,
        defaultUID: String?) -> AudioInputDeviceResolution
    {
        let selected = selectedUID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSelection = selected?.isEmpty == false ? selected : nil
        let usableDefault = defaultUID.flatMap { availableUIDs.contains($0) ? $0 : nil }

        guard let normalizedSelection else {
            return AudioInputDeviceResolution(
                selectedUID: nil,
                resolvedUID: usableDefault,
                fellBackToSystemDefault: false)
        }
        if availableUIDs.contains(normalizedSelection) {
            return AudioInputDeviceResolution(
                selectedUID: normalizedSelection,
                resolvedUID: normalizedSelection,
                fellBackToSystemDefault: false)
        }
        return AudioInputDeviceResolution(
            selectedUID: normalizedSelection,
            resolvedUID: usableDefault,
            fellBackToSystemDefault: true)
    }
}

final class AudioInputDeviceObserver: @unchecked Sendable {
    private let logger = Logger(subsystem: "ai.openclaw", category: "audio.devices")
    private var isActive = false
    private var devicesObservation: AudioPropertyObservation?
    private var defaultInputObservation: AudioPropertyObservation?

    static func defaultInputDeviceUID() -> String? {
        guard let deviceID = self.defaultInputDeviceID() else { return nil }
        return self.deviceUID(for: deviceID)
    }

    static func aliveInputDeviceUIDs() -> Set<String> {
        var output = Set<String>()
        for deviceID in self.deviceIDs() {
            guard self.deviceIsAlive(deviceID) else { continue }
            guard self.deviceHasInput(deviceID) else { continue }
            if let uid = self.deviceUID(for: deviceID) {
                output.insert(uid)
            }
        }
        return output
    }

    static func availableInputDevices() -> [AudioInputDeviceDescriptor] {
        self.deviceIDs().compactMap { deviceID in
            guard self.deviceIsAlive(deviceID), self.deviceHasInput(deviceID) else { return nil }
            guard let uid = self.deviceUID(for: deviceID), let name = self.deviceName(for: deviceID) else { return nil }
            return AudioInputDeviceDescriptor(uid: uid, name: name)
        }.sorted { lhs, rhs in
            lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    static func inputDeviceID(forUID uid: String) -> AudioObjectID? {
        self.deviceIDs().first { deviceID in
            self.deviceIsAlive(deviceID) && self.deviceHasInput(deviceID) && self.deviceUID(for: deviceID) == uid
        }
    }

    static func resolveSelection(_ selectedUID: String?) -> AudioInputDeviceResolution {
        AudioInputDeviceSelectionResolver.resolve(
            selectedUID: selectedUID,
            availableUIDs: self.aliveInputDeviceUIDs(),
            defaultUID: self.defaultInputDeviceUID())
    }

    static func bindSelectedInputIfNeeded(
        _ selection: AudioInputDeviceResolution,
        to input: AVAudioInputNode,
        logger: Logger,
        context: String) -> AudioInputDeviceResolution
    {
        guard selection.shouldBindSelectedDevice, let selectedUID = selection.resolvedUID else {
            return selection
        }
        guard let audioUnit = input.audioUnit,
              var deviceID = self.inputDeviceID(forUID: selectedUID)
        else {
            logger.warning("\(context, privacy: .public) selected input could not be resolved; using system default")
            return self.defaultFallback(for: selection)
        }

        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout<AudioObjectID>.size))
        guard status == noErr else {
            logger.warning(
                "\(context, privacy: .public) selected input binding failed status=\(status); using system default")
            return self.defaultFallback(for: selection)
        }
        logger
            .info(
                "\(context, privacy: .public) selected input bound uid=\(selectedUID, privacy: .private(mask: .hash))")
        return selection
    }

    private static func defaultFallback(for selection: AudioInputDeviceResolution) -> AudioInputDeviceResolution {
        AudioInputDeviceResolution(
            selectedUID: selection.selectedUID,
            resolvedUID: self.resolveSelection(nil).resolvedUID,
            fellBackToSystemDefault: selection.selectedUID != nil)
    }

    /// Returns true when the system default input device exists and is alive with input channels.
    /// Use this preflight before accessing `AVAudioEngine.inputNode` to avoid SIGABRT on Macs
    /// without a built-in microphone (Mac mini, Mac Pro, Mac Studio) or when an external mic
    /// is disconnected.
    static func hasUsableDefaultInputDevice() -> Bool {
        guard let uid = self.defaultInputDeviceUID() else { return false }
        return self.aliveInputDeviceUIDs().contains(uid)
    }

    static func defaultInputDeviceSummary() -> String {
        guard let deviceID = self.defaultInputDeviceID() else {
            return "defaultInput=unknown"
        }
        let uid = self.deviceUID(for: deviceID) ?? "unknown"
        let name = self.deviceName(for: deviceID) ?? "unknown"
        return "defaultInput=\(name) (\(uid))"
    }

    private static func defaultInputDeviceID() -> AudioObjectID? {
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var deviceID = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            systemObject,
            &address,
            0,
            nil,
            &size,
            &deviceID)
        guard status == noErr, deviceID != 0 else { return nil }
        return deviceID
    }

    private static func deviceIDs() -> [AudioObjectID] {
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(systemObject, &address, 0, nil, &size)
        guard status == noErr, size > 0 else { return [] }

        let count = Int(size) / MemoryLayout<AudioObjectID>.size
        var deviceIDs = [AudioObjectID](repeating: 0, count: count)
        status = AudioObjectGetPropertyData(systemObject, &address, 0, nil, &size, &deviceIDs)
        return status == noErr ? deviceIDs : []
    }

    func start(onChange: @escaping @Sendable () -> Void) {
        guard !self.isActive else { return }
        self.isActive = true

        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        let devicesObservation = AudioPropertyObservation(
            objectID: systemObject,
            selector: kAudioHardwarePropertyDevices,
            scope: kAudioObjectPropertyScopeGlobal)
        { _, _ in
            self.logDefaultInputChange(reason: "devices")
            onChange()
        }
        let defaultInputObservation = AudioPropertyObservation(
            objectID: systemObject,
            selector: kAudioHardwarePropertyDefaultInputDevice,
            scope: kAudioObjectPropertyScopeGlobal)
        { _, _ in
            self.logDefaultInputChange(reason: "default")
            onChange()
        }
        let devicesStatus = devicesObservation.status
        let defaultStatus = defaultInputObservation.status

        if devicesStatus != noErr || defaultStatus != noErr {
            self.logger.error("audio device observer install failed devices=\(devicesStatus) default=\(defaultStatus)")
        }

        self.logger.info("audio device observer started (\(Self.defaultInputDeviceSummary(), privacy: .public))")

        self.devicesObservation = devicesObservation
        self.defaultInputObservation = defaultInputObservation
    }

    func stop() {
        guard self.isActive else { return }
        self.isActive = false
        self.devicesObservation?.stop()
        self.defaultInputObservation?.stop()
        self.devicesObservation = nil
        self.defaultInputObservation = nil
    }

    private static func deviceUID(for deviceID: AudioObjectID) -> String? {
        self.deviceStringProperty(kAudioDevicePropertyDeviceUID, for: deviceID)
    }

    private static func deviceName(for deviceID: AudioObjectID) -> String? {
        self.deviceStringProperty(kAudioObjectPropertyName, for: deviceID)
    }

    private static func deviceStringProperty(
        _ selector: AudioObjectPropertySelector,
        for deviceID: AudioObjectID) -> String?
    {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &value)
        guard status == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }

    private static func deviceIsAlive(_ deviceID: AudioObjectID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var alive: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &alive)
        return status == noErr && alive != 0
    }

    private static func deviceHasInput(_ deviceID: AudioObjectID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size)
        guard status == noErr, size > 0 else { return false }

        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size),
            alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let bufferList = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, bufferList)
        guard status == noErr else { return false }

        let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
        return buffers.contains(where: { $0.mNumberChannels > 0 })
    }

    private func logDefaultInputChange(reason: StaticString) {
        self.logger.info("audio input changed (\(reason)) (\(Self.defaultInputDeviceSummary(), privacy: .public))")
    }
}

struct AudioPropertyObservation {
    let objectID: AudioObjectID
    let address: AudioObjectPropertyAddress
    let listener: AudioObjectPropertyListenerBlock
    let status: OSStatus

    init(
        objectID: AudioObjectID,
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        listener: @escaping AudioObjectPropertyListenerBlock)
    {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain)
        self.status = AudioObjectAddPropertyListenerBlock(
            objectID,
            &address,
            DispatchQueue.main,
            listener)
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
