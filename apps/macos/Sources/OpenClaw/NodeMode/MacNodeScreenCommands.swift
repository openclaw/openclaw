import Foundation
import OpenClawKit

struct MacNodeScreenSnapshotParams: Codable, Equatable {
    var screenIndex: Int?
    var maxWidth: Int?
    var quality: Double?
    var format: OpenClawScreenSnapshotFormat?
}

extension MacNodeRuntime {
    static func projectedOuterFrameBytes(
        forPayloadJSON payloadJSON: String,
        requestId: String,
        nodeId: String?) throws -> Int
    {
        struct InvokeResultFrame: Encodable {
            let type = "req"
            let id = "00000000-0000-0000-0000-000000000000"
            let method = "node.invoke.result"
            let params: Params

            struct Params: Encodable {
                let id: String
                let nodeId: String
                let ok: Bool
                let payloadJSON: String
            }
        }

        let frame = InvokeResultFrame(params: InvokeResultFrame.Params(
            id: requestId,
            nodeId: nodeId ?? "",
            ok: true,
            payloadJSON: payloadJSON))
        return try JSONEncoder().encode(frame).count
    }
}
