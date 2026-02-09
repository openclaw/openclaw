import EasyHubKit
import EasyHubProtocol
import Foundation

// Prefer the EasyHubKit wrapper to keep gateway request payloads consistent.
typealias AnyCodable = EasyHubKit.AnyCodable
typealias InstanceIdentity = EasyHubKit.InstanceIdentity

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

extension EasyHubProtocol.AnyCodable {
    var stringValue: String? { self.value as? String }
    var boolValue: Bool? { self.value as? Bool }
    var intValue: Int? { self.value as? Int }
    var doubleValue: Double? { self.value as? Double }
    var dictionaryValue: [String: EasyHubProtocol.AnyCodable]? { self.value as? [String: EasyHubProtocol.AnyCodable] }
    var arrayValue: [EasyHubProtocol.AnyCodable]? { self.value as? [EasyHubProtocol.AnyCodable] }

    var foundationValue: Any {
        switch self.value {
        case let dict as [String: EasyHubProtocol.AnyCodable]:
            dict.mapValues { $0.foundationValue }
        case let array as [EasyHubProtocol.AnyCodable]:
            array.map(\.foundationValue)
        default:
            self.value
        }
    }
}
