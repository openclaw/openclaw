import Foundation
import OpenClawProtocol

/// The encoder owns both wire bytes and transport metadata; consumers cannot construct mismatched facts.
public struct PreparedGatewayRequest: Sendable {
    public enum Body: Sendable {
        case frame(Data)
        case nativeResult(metadata: Data, payloadJSON: String)
    }

    public let body: Body
    public let id: String
    public let method: String
    public let commands: Set<String>?

    init(_ frame: RequestFrame, encoder: JSONEncoder, nativeResults: Bool = false) throws {
        if nativeResults, frame.method == "node.invoke.result",
           var params = frame.params?.value as? [String: OpenClawProtocol.AnyCodable],
           params["ok"]?.value as? Bool == true,
           let payloadJSON = params.removeValue(forKey: "payloadJSON")?.value as? String
        {
            // Freeze every other value now. AnyCodable can hold mutable references;
            // only the owned String may bypass eager encoding for a capable transport.
            let metadata = RequestFrame(
                type: frame.type,
                id: frame.id,
                method: frame.method,
                params: OpenClawProtocol.AnyCodable(params),
                traceparent: frame.traceparent,
                expectedprofileid: frame.expectedprofileid)
            self.body = try .nativeResult(metadata: encoder.encode(metadata), payloadJSON: payloadJSON)
        } else {
            self.body = try .frame(encoder.encode(frame))
        }
        self.id = frame.id
        self.method = frame.method
        if frame.method == "connect" {
            let params = frame.params?.value as? [String: OpenClawProtocol.AnyCodable]
            self.commands = Set(params?["commands"]?.value as? [String] ?? [])
        } else {
            self.commands = nil
        }
    }
}
