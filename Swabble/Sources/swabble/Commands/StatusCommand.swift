import Commander
import Foundation
import Swabble

@MainActor
struct StatusCommand: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "status", abstract: "Show daemon state")
    }

    @Option(name: .long("config"), help: "Path to config JSON") var configPath: String?
    @Option(name: .long("output"), help: "Output format text|json") var output: String = "text"

    init() {}
    init(parsed: ParsedValues) {
        self.init()
        if let cfg = parsed.options["config"]?.last { configPath = cfg }
        if let format = parsed.options["output"]?.last { output = format }
    }

    mutating func run() async throws {
        let outputFormat = CommandOutputFormat(parsedValue: output)
        if let response = await ControlSocketClient.request(
            method: "GET",
            path: "/status?output=\(outputFormat.rawValue)"),
            response.statusCode == 200
        {
            print(response.body)
            return
        }

        let fallback = await renderStatusOutput(format: outputFormat, configURL: configURL)
        print(fallback)
    }

    private var configURL: URL? { configPath.map { URL(fileURLWithPath: $0) } }
}
