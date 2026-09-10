import Foundation
import Network
import Testing
@testable import OpenClawKit

struct GatewayNetworkWebSocketTransportTests {
    @Test func `queued messages respect byte budget and release it on receive`() throws {
        var state = GatewayNetworkWebSocketTask.State()
        let message = URLSessionWebSocketTask.Message.data(Data(repeating: 0, count: 16 * 1024 * 1024))
        try state.bufferMessage(message)
        #expect(throws: URLError.self) { try state.bufferMessage(.string("a")) }
        let received = state.takeBufferedMessage()
        _ = try #require(received)
        try state.bufferMessage(message)
    }

    @Test func `empty queued messages have count limit`() throws {
        var state = GatewayNetworkWebSocketTask.State()
        for _ in 0..<1024 {
            try state.bufferMessage(.string(""))
        }
        #expect(throws: URLError.self) { try state.bufferMessage(.string("")) }
        let received = state.takeBufferedMessage()
        _ = try #require(received)
        try state.bufferMessage(.string(""))
    }

    @Test(arguments: [false, true])
    func `oversized upgrade headers fail`(terminated: Bool) {
        var response = Data(repeating: 65, count: 64 * 1024 + 1)
        if terminated { response.append(Data("\r\n\r\n".utf8)) }
        #expect(throws: URLError.self) {
            try GatewayNetworkWebSocketTask.upgradeHeaderEnd(in: response)
        }
    }

    @Test func `upgrade header limit excludes following web socket bytes`() throws {
        let headers = Data("HTTP/1.1 101 Switching Protocols\r\n\r\n".utf8)
        var response = headers
        response.append(Data(repeating: 0, count: 64 * 1024))
        let end = try #require(try GatewayNetworkWebSocketTask.upgradeHeaderEnd(in: response))
        #expect(end.upperBound == headers.count)
    }

    private struct HostHeaderCase: Sendable {
        let headers: [String: String]
        let expectedHostLines: [String]
    }

    @Test(arguments: [
        HostHeaderCase(headers: [:], expectedHostLines: ["Host: gateway.example:8443"]),
        HostHeaderCase(headers: ["Host": "route.example"], expectedHostLines: ["Host: route.example"]),
        HostHeaderCase(headers: ["host": "route.example"], expectedHostLines: ["Host: route.example"]),
        HostHeaderCase(headers: ["hOsT": "route.example:9443"], expectedHostLines: ["Host: route.example:9443"]),
    ])
    private func `upgrade request emits one normalized Host header`(_ testCase: HostHeaderCase) throws {
        let url = try #require(URL(string: "wss://gateway.example:8443/gateway?auth=bootstrap-token"))
        let request = try GatewayNetworkWebSocketTask.makeUpgradeRequest(
            url: url,
            host: "gateway.example",
            port: #require(NWEndpoint.Port(rawValue: 8443)),
            headers: testCase.headers,
            websocketKey: "dGhlIHNhbXBsZSBub25jZQ==")
        let text = try #require(String(data: request, encoding: .utf8))
        let hostLines = text.components(separatedBy: "\r\n").filter {
            $0.lowercased().hasPrefix("host:")
        }

        #expect(hostLines == testCase.expectedHostLines)
        #expect(text.contains("GET /gateway?auth=bootstrap-token HTTP/1.1"))
    }

    @Test func `frame drain continues after non final fragment consumed from same buffer`() throws {
        var state = GatewayNetworkWebSocketTask.State()
        state.readBuffer.append(Self.serverFrame(opcode: 0x1, payload: Data("hel".utf8), fin: false))
        state.readBuffer.append(Self.serverFrame(opcode: 0x0, payload: Data("lo".utf8), fin: true))

        let frames = try GatewayNetworkWebSocketTask.drainFrames(from: &state).get()

        #expect(frames.count == 1)
        #expect(frames.first?.opcode == 0x1)
        #expect(frames.first?.payload == Data("hello".utf8))
        #expect(state.readBuffer.isEmpty)
    }

    @Test func `frame drain assembles intermediate continuation fragments from same buffer`() throws {
        var state = GatewayNetworkWebSocketTask.State()
        state.readBuffer.append(Self.serverFrame(opcode: 0x2, payload: Data([0x01]), fin: false))
        state.readBuffer.append(Self.serverFrame(opcode: 0x0, payload: Data([0x02]), fin: false))
        state.readBuffer.append(Self.serverFrame(opcode: 0x0, payload: Data([0x03]), fin: true))

        let frames = try GatewayNetworkWebSocketTask.drainFrames(from: &state).get()

        #expect(frames.count == 1)
        #expect(frames.first?.opcode == 0x2)
        #expect(frames.first?.payload == Data([0x01, 0x02, 0x03]))
        #expect(state.readBuffer.isEmpty)
    }

    @Test func `declared oversized frame fails before waiting for full payload`() {
        var state = GatewayNetworkWebSocketTask.State()
        state.readBuffer.append(Self.serverFrameHeader(
            opcode: 0x2,
            length: GatewayNetworkWebSocketTask.maximumMessageSize + 1,
            fin: true))

        switch GatewayNetworkWebSocketTask.nextFrame(from: &state) {
        case let .failure(error):
            #expect((error as? URLError)?.code == .dataLengthExceedsMaximum)
        default:
            Issue.record("Oversized frame should fail without waiting for the declared payload")
        }
    }

    @Test func `fragmented message fails when aggregate payload exceeds maximum`() {
        var state = GatewayNetworkWebSocketTask.State()
        state.fragmentedOpcode = 0x1
        state.fragmentedPayload = Data(repeating: 0, count: GatewayNetworkWebSocketTask.maximumMessageSize)
        state.readBuffer.append(Self.serverFrame(opcode: 0x0, payload: Data([0x01]), fin: true))

        switch GatewayNetworkWebSocketTask.nextFrame(from: &state) {
        case let .failure(error):
            #expect((error as? URLError)?.code == .dataLengthExceedsMaximum)
        default:
            Issue.record("Oversized fragmented message should fail")
        }
    }

    private static func serverFrame(opcode: UInt8, payload: Data, fin: Bool) -> Data {
        var frame = Self.serverFrameHeader(opcode: opcode, length: payload.count, fin: fin)
        frame.append(payload)
        return frame
    }

    private static func serverFrameHeader(opcode: UInt8, length: Int, fin: Bool) -> Data {
        var frame = Data([(fin ? 0x80 : 0x00) | opcode])
        if length <= 125 {
            frame.append(UInt8(length))
        } else if length <= Int(UInt16.max) {
            frame.append(126)
            frame.append(UInt8((length >> 8) & 0xFF))
            frame.append(UInt8(length & 0xFF))
        } else {
            frame.append(127)
            for shift in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((UInt64(length) >> UInt64(shift)) & 0xFF))
            }
        }
        return frame
    }
}
