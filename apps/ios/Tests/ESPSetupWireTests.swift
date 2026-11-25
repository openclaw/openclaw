import Foundation
import Testing
@testable import OpenClaw

struct ESPSetupWireTests {
    @Test func `requests match independent firmware vectors`() throws {
        #expect(try ESPSetupWire.request(.hello, generation: 0) == Data([
            1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]))
        let request = try ESPSetupWire.request(
            .wifi,
            generation: 0xFEDC_BA98_7654_3210,
            id: 0x0102_0304,
            fields: [Data([0xFF, 0x41]), Data()])
        #expect(request == Data([
            1, 4, 0, 0, 0xFE, 0xDC, 0xBA, 0x98, 0x76, 0x54, 0x32, 0x10,
            1, 2, 3, 4, 0, 2, 0xFF, 0x41, 0, 0,
        ]))
        #expect(try ESPSetupWire.Frame(
            kind: 1,
            id: 0x0102_0304,
            total: 3,
            offset: 0,
            payload: Data("abc".utf8)).encoded() == Data([
            0x4F, 0x43, 1, 1, 1, 2, 3, 4, 0, 3, 0, 0, 0, 3, 0, 0, 97, 98, 99,
        ]))
    }

    @Test func `frames reject mismatched lengths and sequence shapes`() throws {
        let ack = Data([0x4F, 0x43, 1, 0x81, 0, 0, 0, 1, 0, 3, 0, 3, 0, 0, 0, 0])
        #expect(try ESPSetupWire.Frame.decode(ack).offset == 3)
        for index in [0, 2, 3, 12, 14] {
            var invalid = ack
            invalid[index] = 0xFE
            #expect(throws: ESPSetupError.self) { try ESPSetupWire.Frame.decode(invalid) }
        }
        #expect(throws: ESPSetupError.self) { try ESPSetupWire.Frame.decode(ack + Data([0])) }
        #expect(throws: ESPSetupError.self) { try ESPSetupWire.Frame.decode(ack.dropLast()) }
        let bytes = Data(repeating: 42, count: 448)
        let frame = try ESPSetupWire.Frame(kind: 0x82, id: 1, total: 448, offset: 0, payload: bytes).encoded()
        #expect(frame.count == 464)
        #expect(try ESPSetupWire.Frame.decode(frame).payload == bytes)
    }

    @Test func `hello preserves generation and comparison byte order`() throws {
        let data = Data([
            1,
            1,
            0,
            0,
            0xFE,
            0xDC,
            0xBA,
            0x98,
            0x76,
            0x54,
            0x32,
            0x10,
            0,
            0,
            0,
            0,
            1,
            5,
            87,
            97,
            116,
            99,
            104,
            4,
            68,
            105,
            97,
            108,
            0xAB,
            0xCD,
            0x12,
            0x34,
        ] + Array(repeating: 0, count: 28))
        let response = try ESPSetupWire.response(data, operation: .hello, generation: 0, id: 0)
        #expect(response.generation == 0xFEDC_BA98_7654_3210)
        let hello = try response.hello()
        #expect(hello.label == "Watch")
        #expect(hello.model == "Dial")
        #expect(hello.comparison == "ABCD 1234")
        var invalidLabel = data
        invalidLabel[18] = 0xFF
        #expect(throws: ESPSetupError.self) {
            try ESPSetupWire.response(invalidLabel, operation: .hello, generation: 0, id: 0).hello()
        }
        #expect(throws: ESPSetupError.self) {
            try ESPSetupWire.response(data, operation: .status, generation: 1, id: 0)
        }
    }

    @Test func `scan retains raw SSID and reports truncation`() throws {
        let data = Data([
            1,
            3,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            7,
            0,
            0,
            0,
            0,
            1,
            1,
            0,
            2,
            2,
            0xFF,
            0x41,
            0xD8,
            6,
            1,
        ])
        let scan = try ESPSetupWire.response(data, operation: .scan, generation: 7, id: 0).networks()
        #expect(scan.truncated)
        #expect(scan.items[0].ssid == Data([0xFF, 0x41]))
        #expect(scan.items[0].rssi == -40)
        #expect(scan.items[0].label == "\\xFF\\x41")
    }

    @Test func `receipt keeps unknown save observation separate from failure`() throws {
        let data = Data([
            1,
            2,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            7,
            0,
            0,
            0,
            9,
            2,
            1,
            4,
            3,
            0,
            0,
            0,
            9,
            0,
            7,
            0,
            0,
            0,
            0,
            0,
            0,
        ])
        let receipt = try ESPSetupWire.response(data, operation: .status, generation: 7, id: 9).receipt()
        #expect(receipt.outcome == 3)
        #expect(receipt.detail == 7)
        #expect(!receipt.saveKnown)
        #expect(throws: ESPSetupError.self) {
            try ESPSetupWire.response(data, operation: .status, generation: 7, id: 10)
        }
    }

    @Test func `discovery is distinct from gateway material`() {
        let valid = #"{"ver":"v1","name":"PROV_OC_1234abcd","username":"openclaw","pop":"0123456789abcdef0123456789abcdef","transport":"ble"}"#
        #expect(ESPSetupDiscovery.parse(valid)?.name == "PROV_OC_1234abcd")
        #expect(ESPSetupDiscovery.parse(valid.replacingOccurrences(of: "ble", with: "softap")) == nil)
        #expect(ESPSetupDiscovery.parse(#"{"url":"wss://example.test","bootstrapToken":"fixture"}"#) == nil)
    }
}
