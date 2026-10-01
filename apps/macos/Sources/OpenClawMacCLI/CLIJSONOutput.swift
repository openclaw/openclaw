import Foundation

func printCLIJSON(_ value: some Encodable, fallback: String? = nil) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) {
        print(text)
    } else if let fallback {
        print(fallback)
    }
}
