import Foundation
import Testing
@testable import OpenClaw

struct MacRealtimeTalkInputChannelsTests {
    private typealias Mapping = MacRealtimeTalkInputChannels

    @Test func `microphone range excludes preceding loopback channels in nested aggregates`() throws {
        let device = Mapping.Device(uid: "engine", inputChannels: 3, children: [
            .init(uid: "output", inputChannels: 2, children: [
                .init(uid: "speakers", inputChannels: 0),
                .init(uid: "loopback", inputChannels: 2),
            ]),
            .init(uid: "microphone", inputChannels: 1),
        ])
        #expect(try Mapping.resolve(
            device: device, selectedInputUID: "microphone", deliveredChannels: 3, channelMap: nil) == 2..<3)
        #expect(try Mapping.resolve(
            device: device, selectedInputUID: "microphone", deliveredChannels: 1, channelMap: [2]) == 0..<1)
    }

    @Test func `unprovable source layouts and AU mappings never select a guessed microphone`() {
        let microphone = Mapping.Device(uid: "microphone", inputChannels: 2)
        let failures: [(Mapping.Device, Int, [Int32]?)] = [
            (.init(uid: "other", inputChannels: 2), 2, nil),
            (.init(uid: "aggregate", inputChannels: 4, children: [microphone, microphone]), 4, nil),
            (.init(uid: "aggregate", inputChannels: 3, children: [microphone]), 3, nil),
            (microphone, 1, nil),
            (microphone, 2, [0, 0]),
            (microphone, 2, [0, -1]),
            (microphone, 2, [0, 2]),
            (microphone, 3, [0, -1, 1]),
        ]
        for (device, count, map) in failures {
            #expect(throws: Mapping.MappingError.self) {
                try Mapping.resolve(
                    device: device, selectedInputUID: "microphone", deliveredChannels: count, channelMap: map)
            }
        }
    }

    @Test func `direct selected microphone and reordered complete stereo maps retain only selected samples`() throws {
        let device = Mapping.Device(uid: "microphone", inputChannels: 2)
        #expect(try Mapping.resolve(
            device: device, selectedInputUID: "microphone", deliveredChannels: 2, channelMap: nil) == 0..<2)
        #expect(try Mapping.resolve(
            device: device, selectedInputUID: "microphone", deliveredChannels: 2, channelMap: [1, 0]) == 0..<2)
    }

    @Test(arguments: [false, true])
    func `aggregate selection requires an explicit leaf even with one active child`(includesLoopback: Bool) throws {
        var children = [Mapping.Device(uid: "microphone", inputChannels: 1)]
        if includesLoopback {
            children.append(.init(uid: "loopback", inputChannels: 2))
        }
        let channels = includesLoopback ? 3 : 1
        let device = Mapping.Device(uid: "aggregate", inputChannels: channels, children: children)
        #expect(throws: Mapping.MappingError.aggregateInputSelected) {
            try Mapping.resolve(
                device: device, selectedInputUID: "aggregate", deliveredChannels: channels, channelMap: nil)
        }
        #expect(try Mapping.resolve(
            device: device, selectedInputUID: "microphone", deliveredChannels: channels, channelMap: nil) == 0..<1)
    }

    @Test func `aggregate input failure recommends selecting a microphone without mislabeling other failures`() {
        let error = Mapping.MappingError.aggregateInputSelected
        #expect(error.errorDescription?.contains("aggregate device") == true)
        #expect(error.recoverySuggestion?.contains("Select an individual microphone") == true)
        #expect(error.recoverySuggestion?.contains("turn Talk off and on") == true)
        #expect(Mapping.MappingError.selectedInputMissingOrAmbiguous.recoverySuggestion == nil)
        #expect(Mapping.MappingError.unreadableLayout.recoverySuggestion == nil)
    }

    @Test(arguments: [false, true])
    func `native fallback presentation preserves aggregate recovery and existing statuses`(
        recognitionStarted: Bool) throws
    {
        let suggestion = try #require(Mapping.MappingError.aggregateInputSelected.recoverySuggestion)
        let base = recognitionStarted
            ? "native"
            : String(localized: "Realtime unavailable — native speech could not start")
        #expect(TalkModeRuntime.nativeFallbackStatus(
            recognitionStarted: recognitionStarted, status: "native", recoverySuggestion: suggestion) ==
            "\(base) \(suggestion)")
        #expect(TalkModeRuntime.nativeFallbackStatus(
            recognitionStarted: recognitionStarted, status: "native", recoverySuggestion: nil) == base)
        #expect(TalkModeRuntime.nativeFallbackStatus(
            recognitionStarted: true, status: nil, recoverySuggestion: nil) == nil)
    }
}
