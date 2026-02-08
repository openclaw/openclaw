import Foundation
import OpenClawKit
import OpenClawProtocol

// Prefer the OpenClawKit wrapper to keep gateway request payloads consistent.
typealias AnyCodable = OpenClawKit.AnyCodable
typealias InstanceIdentity = OpenClawKit.InstanceIdentity

extension AnyCodable {
    var stringValue: String? {
        self.value as? String
    }

    var boolValue: Bool? {
        self.value as? Bool
    }

    var intValue: Int? {
        self.value as? Int
    }

    var doubleValue: Double? {
        self.value as? Double
    }

    var dictionaryValue: [String: AnyCodable]? {
        self.value as? [String: AnyCodable]
    }

    var arrayValue: [AnyCodable]? {
        self.value as? [AnyCodable]
    }

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

extension OpenClawProtocol.AnyCodable {
    var stringValue: String? {
        self.value as? String
    }

    var boolValue: Bool? {
        self.value as? Bool
    }

    var intValue: Int? {
        self.value as? Int
    }

    var doubleValue: Double? {
        self.value as? Double
    }

    var dictionaryValue: [String: OpenClawProtocol.AnyCodable]? {
        self.value as? [String: OpenClawProtocol.AnyCodable]
    }

    var arrayValue: [OpenClawProtocol.AnyCodable]? {
        self.value as? [OpenClawProtocol.AnyCodable]
    }

    var foundationValue: Any {
        switch self.value {
        case let dict as [String: OpenClawProtocol.AnyCodable]:
            dict.mapValues { $0.foundationValue }
        case let array as [OpenClawProtocol.AnyCodable]:
            array.map(\.foundationValue)
        default:
            self.value
        }
    }
}
