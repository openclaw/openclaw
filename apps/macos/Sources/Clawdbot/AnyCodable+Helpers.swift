import ClawdbotKit
import ClawdbotProtocol
import Foundation

// Prefer the ClawdbotKit wrapper to keep gateway request payloads consistent.
typealias AnyCodable = ClawdbotKit.AnyCodable
typealias InstanceIdentity = ClawdbotKit.InstanceIdentity

extension AnyCodable {
    var stringValue: String? { self.value as? String }
    var boolValue: Bool? { self.value as? Bool }
    var intValue: Int? { self.value as? Int }
    var doubleValue: Double? { self.value as? Double }
    var dictionaryValue: [String: AnyCodable]? { self.value as? [String: AnyCodable] }
    var arrayValue: [AnyCodable]? { self.value as? [AnyCodable] }

    var foundationValue: Any {
        switch self.value {
        case let dict as [String: AnyCodable]:
            dict.mapValues { $0.foundationValue }
        case let array as [AnyCodable]:
            array.map(\.foundationValue)
        default:
            self.value
        }
    }
}

extension ClawdbotProtocol.AnyCodable {
    var stringValue: String? { self.value as? String }
    var boolValue: Bool? { self.value as? Bool }
    var intValue: Int? { self.value as? Int }
    var doubleValue: Double? { self.value as? Double }
    var dictionaryValue: [String: ClawdbotProtocol.AnyCodable]? { self.value as? [String: ClawdbotProtocol.AnyCodable] }
    var arrayValue: [ClawdbotProtocol.AnyCodable]? { self.value as? [ClawdbotProtocol.AnyCodable] }

    var foundationValue: Any {
        switch self.value {
        case let dict as [String: ClawdbotProtocol.AnyCodable]:
            dict.mapValues { $0.foundationValue }
        case let array as [ClawdbotProtocol.AnyCodable]:
            array.map(\.foundationValue)
        default:
            self.value
        }
    }
}
