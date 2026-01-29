import DNAKit
import DNAProtocol
import Foundation

// Prefer the DNAKit wrapper to keep gateway request payloads consistent.
typealias AnyCodable = DNAKit.AnyCodable
typealias InstanceIdentity = DNAKit.InstanceIdentity

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

extension DNAProtocol.AnyCodable {
    var stringValue: String? { self.value as? String }
    var boolValue: Bool? { self.value as? Bool }
    var intValue: Int? { self.value as? Int }
    var doubleValue: Double? { self.value as? Double }
    var dictionaryValue: [String: DNAProtocol.AnyCodable]? { self.value as? [String: DNAProtocol.AnyCodable] }
    var arrayValue: [DNAProtocol.AnyCodable]? { self.value as? [DNAProtocol.AnyCodable] }

    var foundationValue: Any {
        switch self.value {
        case let dict as [String: DNAProtocol.AnyCodable]:
            dict.mapValues { $0.foundationValue }
        case let array as [DNAProtocol.AnyCodable]:
            array.map(\.foundationValue)
        default:
            self.value
        }
    }
}
