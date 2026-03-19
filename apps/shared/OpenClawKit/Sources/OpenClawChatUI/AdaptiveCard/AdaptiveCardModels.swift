import Foundation

// MARK: - Adaptive Card v1.6 Codable models

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
    case table(Table)
    case richTextBlock(RichTextBlock)
    case codeBlock(CodeBlock)
    case imageSet(ImageSet)
    case actionSet(ActionSet)
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

    struct TableColumnDefinition: Codable {
        let width: String?
        let horizontalCellContentAlignment: String?
    }

    struct TableCell: Codable {
        let items: [CardElement]?
    }

    struct TableRow: Codable {
        let cells: [TableCell]?
    }

    struct Table: Codable {
        let columns: [TableColumnDefinition]?
        let rows: [TableRow]
    }

    struct TextRun: Codable {
        let text: String
        let weight: String?
        let italic: Bool?
        let strikethrough: Bool?
        let highlight: Bool?
        let color: String?
        let size: String?
    }

    struct RichTextBlock: Codable {
        let inlines: [TextRun]
    }

    struct CodeBlock: Codable {
        let codeSnippet: String
        let language: String?
    }

    struct ImageSet: Codable {
        let images: [ImageElement]
        let imageSize: String?
    }

    struct ActionSet: Codable {
        let actions: [CardAction]
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
        case "Table":
            self = .table(try Table(from: decoder))
        case "RichTextBlock":
            self = .richTextBlock(try RichTextBlock(from: decoder))
        case "CodeBlock":
            self = .codeBlock(try CodeBlock(from: decoder))
        case "ImageSet":
            self = .imageSet(try ImageSet(from: decoder))
        case "ActionSet":
            self = .actionSet(try ActionSet(from: decoder))
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
        case .table(let t):
            try container.encode("Table", forKey: .type)
            try t.encode(to: encoder)
        case .richTextBlock(let rtb):
            try container.encode("RichTextBlock", forKey: .type)
            try rtb.encode(to: encoder)
        case .codeBlock(let cb):
            try container.encode("CodeBlock", forKey: .type)
            try cb.encode(to: encoder)
        case .imageSet(let imgSet):
            try container.encode("ImageSet", forKey: .type)
            try imgSet.encode(to: encoder)
        case .actionSet(let actSet):
            try container.encode("ActionSet", forKey: .type)
            try actSet.encode(to: encoder)
        case .unknown:
            try container.encode("Unknown", forKey: .type)
        }
    }
}

enum CardAction: Codable {
    case submit(SubmitAction)
    case execute(ExecuteAction)
    case openUrl(OpenUrlAction)
    case unknown

    struct SubmitAction: Codable {
        let title: String?
        let data: AnyCodableAction?
    }

    struct ExecuteAction: Codable {
        let title: String?
        let verb: String?
        let data: AnyCodableAction?
    }

    struct OpenUrlAction: Codable {
        let title: String?
        let url: String
    }

    // Lightweight any-value wrapper for action data (no external deps)
    struct AnyCodableAction: Codable {
        let value: Any

        init(_ value: Any) {
            self.value = value
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let dict = try? container.decode([String: AnyCodableAction].self) {
                self.value = dict.mapValues { $0.value }
            } else if let arr = try? container.decode([AnyCodableAction].self) {
                self.value = arr.map { $0.value }
            } else if let b = try? container.decode(Bool.self) {
                self.value = b
            } else if let i = try? container.decode(Int.self) {
                self.value = i
            } else if let d = try? container.decode(Double.self) {
                self.value = d
            } else if let str = try? container.decode(String.self) {
                self.value = str
            } else {
                self.value = ""
            }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            if let dict = self.value as? [String: Any] {
                let wrapped = dict.mapValues { AnyCodableAction($0) }
                try container.encode(wrapped)
            } else if let arr = self.value as? [Any] {
                let wrapped = arr.map { AnyCodableAction($0) }
                try container.encode(wrapped)
            } else if let b = self.value as? Bool {
                try container.encode(b)
            } else if let i = self.value as? Int {
                try container.encode(i)
            } else if let d = self.value as? Double {
                try container.encode(d)
            } else if let str = self.value as? String {
                try container.encode(str)
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
        case "Action.Execute":
            self = .execute(try ExecuteAction(from: decoder))
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
        case .execute(let a):
            try container.encode("Action.Execute", forKey: .type)
            try a.encode(to: encoder)
        case .openUrl(let a):
            try container.encode("Action.OpenUrl", forKey: .type)
            try a.encode(to: encoder)
        case .unknown:
            try container.encode("Unknown", forKey: .type)
        }
    }
}
