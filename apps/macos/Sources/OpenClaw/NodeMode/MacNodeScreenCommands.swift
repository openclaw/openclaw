import Foundation
import OpenClawKit

struct MacNodeScreenSnapshotParams: Codable, Equatable {
    var screenIndex: Int?
    var maxWidth: Int?
    var quality: Double?
    var format: OpenClawScreenSnapshotFormat?
}
