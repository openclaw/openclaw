import Foundation

func printCLIJSON(_ value: some Encodable, fallback: String? = nil) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(value) {
        print(String(bytes: data, encoding: .utf8)!)
    } else if let fallback {
        print(fallback)
    }
}
