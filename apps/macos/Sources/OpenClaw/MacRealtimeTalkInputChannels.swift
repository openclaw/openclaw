import AudioToolbox
@preconcurrency import AVFoundation
import CoreAudio
import Foundation

enum MacRealtimeTalkInputChannels {
    struct Device {
        let uid: String
        let inputChannels: Int
        var children: [Device] = []
    }

    enum MappingError: Error, Equatable, LocalizedError {
        case unreadableLayout
        case invalidLayout
        case selectedInputMissingOrAmbiguous
        case aggregateInputSelected
        case unsupportedChannelMap

        var errorDescription: String? {
            if self == .aggregateInputSelected {
                return String(localized: "Realtime Talk cannot use an aggregate device as its microphone.")
            }
            return "The microphone's audio channels could not be verified. Reconnect the microphone and try again."
        }

        var recoverySuggestion: String? {
            guard self == .aggregateInputSelected else { return nil }
            return String(localized:
                "Select an individual microphone in Settings → Talk → This Mac, then turn Talk off and on.")
        }
    }

    @MainActor
    static func resolve(input: AVAudioInputNode, selectedInputUID: String) throws -> Range<Int> {
        guard let unit = input.audioUnit else { throw MappingError.unreadableLayout }
        var deviceID: AudioObjectID = 0
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioUnitGetProperty(
            unit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            &size) == noErr, deviceID != kAudioObjectUnknown
        else { throw MappingError.unreadableLayout }
        let device = try self.readDevice(deviceID, ancestors: [])
        let deliveredChannels = Int(input.outputFormat(forBus: 0).channelCount)
        return try self.resolve(
            device: device,
            selectedInputUID: selectedInputUID,
            deliveredChannels: deliveredChannels,
            channelMap: self.readChannelMap(unit))
    }

    static func resolve(
        device: Device,
        selectedInputUID: String,
        deliveredChannels: Int,
        channelMap: [Int32]?) throws -> Range<Int>
    {
        var matches: [Range<Int>] = []
        try self.collect(device, selectedInputUID: selectedInputUID, offset: 0, matches: &matches)
        guard matches.count == 1, let source = matches.first, !source.isEmpty else {
            throw MappingError.selectedInputMissingOrAmbiguous
        }
        guard deliveredChannels > 0 else { throw MappingError.invalidLayout }
        let mapping: [Int32]
        if let channelMap {
            mapping = channelMap
        } else {
            // TN2091 defines the absent channel map as identity. Never infer
            // downmixing when the AU's delivered channel count differs.
            guard deliveredChannels == device.inputChannels else { throw MappingError.unsupportedChannelMap }
            mapping = (0..<deliveredChannels).map(Int32.init)
        }
        guard mapping.count == deliveredChannels,
              mapping.allSatisfy({ $0 == -1 || (0..<device.inputChannels).contains(Int($0)) })
        else { throw MappingError.unsupportedChannelMap }
        let destinations = mapping.indices.filter { source.contains(Int(mapping[$0])) }
        guard destinations.count == source.count,
              Set(destinations.map { mapping[$0] }).count == source.count,
              let first = destinations.first, let last = destinations.last,
              last - first + 1 == destinations.count
        else { throw MappingError.unsupportedChannelMap }
        return first..<(last + 1)
    }

    private static func collect(
        _ device: Device, selectedInputUID: String, offset: Int, matches: inout [Range<Int>]) throws
    {
        guard device.inputChannels >= 0 else { throw MappingError.invalidLayout }
        if device.uid == selectedInputUID {
            // An aggregate UID selects a composition, not a verified microphone leaf.
            // Reject even one active child: later composition changes must not widen capture.
            guard device.children.isEmpty else { throw MappingError.aggregateInputSelected }
            matches.append(offset..<(offset + device.inputChannels))
        }
        guard !device.children.isEmpty else { return }
        guard device.children.reduce(0, { $0 + $1.inputChannels }) == device.inputChannels else {
            throw MappingError.invalidLayout
        }
        var childOffset = offset
        for child in device.children {
            try self.collect(child, selectedInputUID: selectedInputUID, offset: childOffset, matches: &matches)
            childOffset += child.inputChannels
        }
    }

    private static func readDevice(_ id: AudioObjectID, ancestors: Set<AudioObjectID>) throws -> Device {
        guard !ancestors.contains(id), ancestors.count < 16,
              let uid = try self.readCFProperty(id, selector: kAudioDevicePropertyDeviceUID) as? String
        else { throw MappingError.invalidLayout }
        let inputChannels = try self.readInputChannels(id)
        var property = self.address(kAudioAggregateDevicePropertyActiveSubDeviceList)
        guard AudioObjectHasProperty(id, &property) else {
            return Device(uid: uid, inputChannels: inputChannels)
        }
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &property, 0, nil, &size) == noErr,
              size.isMultiple(of: UInt32(MemoryLayout<AudioObjectID>.size))
        else { throw MappingError.unreadableLayout }
        var active = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        if !active.isEmpty {
            guard AudioObjectGetPropertyData(id, &property, 0, nil, &size, &active) == noErr else {
                throw MappingError.unreadableLayout
            }
        }
        guard !active.isEmpty || inputChannels == 0,
              let orderedUIDs = try self.readCFProperty(
                  id, selector: kAudioAggregateDevicePropertyFullSubDeviceList) as? [String],
              Set(orderedUIDs).count == orderedUIDs.count
        else { throw MappingError.invalidLayout }
        var children = try active.map { try self.readDevice($0, ancestors: ancestors.union([id])) }
        guard Set(children.map(\.uid)).count == children.count,
              children.allSatisfy({ orderedUIDs.contains($0.uid) })
        else { throw MappingError.invalidLayout }
        // FullSubDeviceList defines stream order; ActiveSubDeviceList only
        // promises membership. Ignore inactive devices without shifting channels.
        children.sort { orderedUIDs.firstIndex(of: $0.uid)! < orderedUIDs.firstIndex(of: $1.uid)! }
        return Device(uid: uid, inputChannels: inputChannels, children: children)
    }

    private static func readChannelMap(_ unit: AudioUnit) throws -> [Int32]? {
        var size: UInt32 = 0
        var writable = DarwinBoolean(false)
        guard AudioUnitGetPropertyInfo(
            unit,
            kAudioOutputUnitProperty_ChannelMap,
            kAudioUnitScope_Output,
            1,
            &size,
            &writable) == noErr,
            size.isMultiple(of: UInt32(MemoryLayout<Int32>.size))
        else { throw MappingError.unreadableLayout }
        guard size > 0 else { return nil }
        var map = [Int32](repeating: -1, count: Int(size) / MemoryLayout<Int32>.size)
        guard AudioUnitGetProperty(
            unit,
            kAudioOutputUnitProperty_ChannelMap,
            kAudioUnitScope_Output,
            1,
            &map,
            &size) == noErr
        else { throw MappingError.unreadableLayout }
        return map
    }

    private static func readInputChannels(_ id: AudioObjectID) throws -> Int {
        var property = self.address(kAudioDevicePropertyStreamConfiguration, scope: kAudioDevicePropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &property, 0, nil, &size) == noErr else {
            throw MappingError.unreadableLayout
        }
        let bufferOffset = MemoryLayout<AudioBufferList>.offset(of: \.mBuffers)!
        guard Int(size) >= bufferOffset else { throw MappingError.invalidLayout }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: max(Int(size), MemoryLayout<AudioBufferList>.size),
            alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        guard AudioObjectGetPropertyData(id, &property, 0, nil, &size, list) == noErr,
              bufferOffset + Int(list.pointee.mNumberBuffers) * MemoryLayout<AudioBuffer>.size <= Int(size)
        else { throw MappingError.unreadableLayout }
        return UnsafeMutableAudioBufferListPointer(list).reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    private static func readCFProperty(_ id: AudioObjectID, selector: AudioObjectPropertySelector) throws -> CFTypeRef {
        var property = self.address(selector)
        var value: Unmanaged<CFTypeRef>?
        var size = UInt32(MemoryLayout<Unmanaged<CFTypeRef>?>.size)
        guard AudioObjectGetPropertyData(id, &property, 0, nil, &size, &value) == noErr,
              let value
        else { throw MappingError.unreadableLayout }
        return value.takeRetainedValue()
    }

    private static func address(
        _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress
    {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }
}
