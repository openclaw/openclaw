import Foundation

// MARK: - Adaptive Card v1.5 Codable models

struct AdaptiveCard: Codable {
    let type: String
    let version: String?
    let body: [CardElement]
    let actions: [CardAction]?
}

enum CardElement: Codable {
    case textBlock(TextBlock)
    case factSet(FactSet)
    case columnSet(ColumnSet)
    case container(Container)
    case image(ImageElement)
    case unknown

    struct TextBlock: Codable {
        let text: String
        let size: String?
        let weight: String?
        let color: String?
        let isSubtle: Bool?
        let wrap: Bool?
        let separator: Bool?
    }

    struct Fact: Codable {
        let title: String
        let value: String
    }

    struct FactSet: Codable {
        let facts: [Fact]
    }

    struct Column: Codable {
        let width: String?
        let items: [CardElement]?
    }

    struct ColumnSet: Codable {
        let columns: [Column]
    }

    struct Container: Codable {
        let items: [CardElement]
        let style: String?
    }

    struct ImageElement: Codable {
        let url: String
        let altText: String?
        let size: String?
    }

    // Manual decoding keyed on "type"
    private enum CodingKeys: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let elementType = try container.decodeIfPresent(String.self, forKey: .type) ?? ""

        switch elementType {
        case "TextBlock":
            self = .textBlock(try TextBlock(from: decoder))
        case "FactSet":
            self = .factSet(try FactSet(from: decoder))
        case "ColumnSet":
            self = .columnSet(try ColumnSet(from: decoder))
        case "Container":
            self = .container(try Container(from: decoder))
        case "Image":
            self = .image(try ImageElement(from: decoder))
        default:
            self = .unknown
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .textBlock(let tb):
            try container.encode("TextBlock", forKey: .type)
            try tb.encode(to: encoder)
        case .factSet(let fs):
            try container.encode("FactSet", forKey: .type)
            try fs.encode(to: encoder)
        case .columnSet(let cs):
            try container.encode("ColumnSet", forKey: .type)
            try cs.encode(to: encoder)
        case .container(let c):
            try container.encode("Container", forKey: .type)
            try c.encode(to: encoder)
        case .image(let img):
            try container.encode("Image", forKey: .type)
            try img.encode(to: encoder)
        case .unknown:
            try container.encode("Unknown", forKey: .type)
        }
    }
}

enum CardAction: Codable {
    case submit(SubmitAction)
    case openUrl(OpenUrlAction)
    case unknown

    struct SubmitAction: Codable {
        let title: String?
        let data: AnyCodableAction?
    }

    struct OpenUrlAction: Codable {
        let title: String?
        let url: String
    }

    // Lightweight any-value wrapper for action data (no external deps)
    struct AnyCodableAction: Codable {
        let value: Any

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            // Try types from most specific to least specific (JSONValue-style)
            if let dict = try? container.decode([String: AnyCodableAction].self) {
                self.value = dict
            } else if let arr = try? container.decode([AnyCodableAction].self) {
                self.value = arr
            } else if let str = try? container.decode(String.self) {
                self.value = str
            } else if let num = try? container.decode(Double.self) {
                self.value = num
            } else if let bool = try? container.decode(Bool.self) {
                self.value = bool
            } else if let int = try? container.decode(Int.self) {
                self.value = int
            } else {
                self.value = ""
            }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            if let dict = self.value as? [String: AnyCodableAction] {
                try container.encode(dict)
            } else if let arr = self.value as? [AnyCodableAction] {
                try container.encode(arr)
            } else if let str = self.value as? String {
                try container.encode(str)
            } else if let num = self.value as? Double {
                try container.encode(num)
            } else if let bool = self.value as? Bool {
                try container.encode(bool)
            } else if let int = self.value as? Int {
                try container.encode(int)
            }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let actionType = try container.decodeIfPresent(String.self, forKey: .type) ?? ""

        switch actionType {
        case "Action.Submit":
            self = .submit(try SubmitAction(from: decoder))
        case "Action.OpenUrl":
            self = .openUrl(try OpenUrlAction(from: decoder))
        default:
            self = .unknown
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .submit(let a):
            try container.encode("Action.Submit", forKey: .type)
            try a.encode(to: encoder)
        case .openUrl(let a):
            try container.encode("Action.OpenUrl", forKey: .type)
            try a.encode(to: encoder)
        case .unknown:
            try container.encode("Unknown", forKey: .type)
        }
    }
}
