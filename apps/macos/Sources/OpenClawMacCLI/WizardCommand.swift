import Darwin
import Foundation
import OpenClawKit
import OpenClawProtocol

struct WizardCliOptions {
    var url: String?
    var token: String?
    var password: String?
    var mode: String = "local"
    var workspace: String?
    var json: Bool = false
    var help: Bool = false

    static func parse(_ args: [String]) -> WizardCliOptions {
        var opts = WizardCliOptions()
        var i = 0
        while i < args.count {
            let arg = args[i]
            switch arg {
            case "-h", "--help":
                opts.help = true
            case "--json":
                opts.json = true
            case "--url":
                opts.url = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--token":
                opts.token = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--password":
                opts.password = CLIArgParsingSupport.nextValue(args, index: &i)
            case "--mode":
                if let value = CLIArgParsingSupport.nextValue(args, index: &i) {
                    opts.mode = value
                }
            case "--workspace":
                opts.workspace = CLIArgParsingSupport.nextValue(args, index: &i)
            default:
                break
            }
            i += 1
        }
        return opts
    }
}

enum WizardCliError: Error, CustomStringConvertible {
    case invalidUrl(String)
    case missingRemoteUrl
    case gatewayError(String)
    case decodeError(String)
    case cancelled

    var description: String {
        switch self {
        case let .invalidUrl(raw): "Invalid URL: \(raw)"
        case .missingRemoteUrl: "gateway.remote.url is missing"
        case let .gatewayError(msg), let .decodeError(msg): msg
        case .cancelled: "Wizard cancelled"
        }
    }
}

func runWizardCommand(_ args: [String], configURL: URL) async {
    let opts = WizardCliOptions.parse(args)
    if opts.help {
        print("""
        openclaw-mac wizard

        Usage:
          openclaw-mac wizard [--url <ws://host:port>] [--token <token>] [--password <password>]
                              [--mode <local|remote>] [--workspace <path>] [--json]

        Options:
          --profile <name>  App profile; overrides OPENCLAW_PROFILE (default: default)
          --url <url>        Gateway WebSocket URL (overrides config)
          --token <token>    Gateway token (if required)
          --password <pw>    Gateway password (if required)
          --mode <mode>      Wizard mode (local|remote). Default: local
          --workspace <path> Wizard workspace override
          --json             Print raw wizard responses
          -h, --help         Show help
        """)
        return
    }

    let config = loadGatewayConfig(from: configURL)
    do {
        guard isatty(STDIN_FILENO) != 0 else {
            throw WizardCliError.gatewayError("Wizard requires an interactive TTY.")
        }
        let endpoint = try resolveWizardGatewayEndpoint(opts: opts, config: config)
        let client = GatewayChannelActor(
            url: endpoint.url,
            token: endpoint.token,
            password: endpoint.password,
            connectOptions: GatewayConnectOptions(
                role: "operator",
                scopes: GatewayChannelActor.defaultOperatorConnectScopes,
                scopesAreExplicit: true,
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-macos",
                clientMode: "ui",
                clientDisplayName: Host.current().localizedName ?? "OpenClaw macOS Wizard CLI",
                allowStoredDeviceAuth: false))
        do {
            try await client.connect()
            guard let generation = await client.currentConnectionGeneration() else {
                throw WizardCliError.gatewayError("gateway not connected")
            }
            try await runWizard(client: client, connectionGeneration: generation, opts: opts)
        } catch {
            await client.shutdown()
            if let error = error as? GatewayConnectAuthError {
                throw WizardCliError.gatewayError(error.message)
            }
            throw error
        }
        await client.shutdown()
    } catch {
        fputs("wizard: \(error)\n", stderr)
        exit(1)
    }
}

private func resolveWizardGatewayEndpoint(opts: WizardCliOptions, config: GatewayConfig) throws -> GatewayEndpoint {
    let mode = (config.mode ?? "local").lowercased()
    let raw: String
    if let explicitURL = opts.url, !explicitURL.isEmpty {
        raw = explicitURL
    } else if mode == "remote" {
        guard let remoteURL = config.remoteUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
              !remoteURL.isEmpty else { throw WizardCliError.missingRemoteUrl }
        raw = remoteURL
    } else {
        raw = "ws://127.0.0.1:\(config.port ?? 18789)"
    }
    guard let url = URL(string: raw) else { throw WizardCliError.invalidUrl(raw) }
    return GatewayEndpoint(
        url: url,
        token: resolvedCredential(opts.token, mode: mode, local: config.token, remote: config.remoteToken),
        password: resolvedCredential(opts.password, mode: mode, local: config.password, remote: config.remotePassword),
        mode: mode)
}

private func runWizard(
    client: GatewayChannelActor,
    connectionGeneration: UInt64,
    opts: WizardCliOptions) async throws
{
    func request(method: String, params: [String: ProtoAnyCodable]) async throws -> Data {
        do {
            // A wizard session belongs to one socket; never replay an answer after reconnect.
            return try await client.request(
                method: method,
                params: params,
                timeoutMs: 0,
                ifCurrentConnectionGeneration: connectionGeneration)
        } catch let error as GatewayResponseError {
            throw WizardCliError.gatewayError(error.message)
        }
    }

    var params: [String: ProtoAnyCodable] = [:]
    let mode = opts.mode.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if mode == "local" || mode == "remote" {
        params["mode"] = ProtoAnyCodable(mode)
    }
    if let workspace = opts.workspace?.trimmingCharacters(in: .whitespacesAndNewlines), !workspace.isEmpty {
        params["workspace"] = ProtoAnyCodable(workspace)
    }

    let startResponse = try await request(method: "wizard.start", params: params)
    let startResult = try decodeWizardResult(startResponse, as: WizardStartResult.self)
    if opts.json {
        dumpResult(startResponse)
    }

    let sessionId = startResult.sessionid
    var nextResult = WizardNextResult(
        done: startResult.done,
        step: startResult.step,
        status: startResult.status,
        error: startResult.error)

    do {
        while true {
            let status = wizardStatusString(nextResult.status) ?? (nextResult.done ? "done" : "running")
            if status == "cancelled" {
                print("Wizard cancelled.")
                return
            }
            if status == "error" || (nextResult.done && nextResult.error != nil) {
                throw WizardCliError.gatewayError(nextResult.error ?? "wizard error")
            }
            if status == "done" || nextResult.done {
                print("Wizard complete.")
                return
            }
            if let error = nextResult.error, !opts.json {
                fputs("wizard: \(error)\n", stderr)
            }

            // Gateway-executed steps (download/install progress) take no answer;
            // echo the frame and poll, or the run stalls on input that can never
            // advance the session.
            var nextParams = ["sessionId": ProtoAnyCodable(sessionId)]
            if let step = nextResult.step, wizardStepExecutor(step) != "gateway" {
                let answer = try promptAnswer(for: step)
                var answerPayload: [String: ProtoAnyCodable] = [
                    "stepId": ProtoAnyCodable(step.id),
                ]
                if !(answer is NSNull) {
                    answerPayload["value"] = ProtoAnyCodable(answer)
                }
                nextParams["answer"] = ProtoAnyCodable(answerPayload)
            } else if let step = nextResult.step, !opts.json {
                printWizardStepHeader(step)
            }
            let response = try await request(method: "wizard.next", params: nextParams)
            nextResult = try decodeWizardResult(response, as: WizardNextResult.self)
            if opts.json {
                dumpResult(response)
            }
        }
    } catch WizardCliError.cancelled {
        _ = try? await request(
            method: "wizard.cancel",
            params: ["sessionId": ProtoAnyCodable(sessionId)])
        throw WizardCliError.cancelled
    }
}

private func decodeWizardResult<T: Decodable>(_ data: Data, as _: T.Type) throws -> T {
    guard !data.isEmpty else { throw WizardCliError.decodeError("missing payload") }
    return try JSONDecoder().decode(T.self, from: data)
}

private func dumpResult(_ data: Data) {
    guard let payload = try? JSONDecoder().decode(ProtoAnyCodable.self, from: data) else {
        print("{\"error\":\"missing payload\"}")
        return
    }
    printCLIJSON(payload)
}

private func printWizardStepHeader(_ step: WizardStep) {
    if let title = step.title, !title.isEmpty {
        print("\n\(title)")
    }
    if let message = step.message, !message.isEmpty {
        print(message)
    }
}

private func promptAnswer(for step: WizardStep) throws -> Any {
    let type = wizardStepType(step)
    printWizardStepHeader(step)

    switch type {
    case "action":
        _ = try readLineWithPrompt("Run? (enter)")
        return true
    case "text":
        let initial = anyCodableString(step.initialvalue)
        let prompt = step.placeholder ?? "Value"
        let value: String
        if step.sensitive == true {
            let sensitivePrompt = initial.isEmpty ? prompt : "\(prompt) (leave blank to keep existing)"
            value = try readSensitiveLineWithPrompt(sensitivePrompt)
        } else {
            value = try readLineWithPrompt("\(prompt)\(initial.isEmpty ? "" : " [\(initial)]")")
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? initial : trimmed
    case "confirm":
        let initial = anyCodableBool(step.initialvalue)
        let value = try readLineWithPrompt("Confirm? (y/n) [\(initial ? "y" : "n")]")
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.isEmpty { return initial }
        return trimmed == "y" || trimmed == "yes" || trimmed == "true"
    case "select":
        return try promptSelect(step, multiple: false).first ?? NSNull()
    case "multiselect":
        return try promptSelect(step, multiple: true)
    default:
        _ = try readLineWithPrompt("Continue? (enter)")
        return NSNull()
    }
}

private func promptSelect(_ step: WizardStep, multiple: Bool) throws -> [Any] {
    let options = parseWizardOptions(step.options)
    guard !options.isEmpty else { return [] }
    for (idx, option) in options.enumerated() {
        let hint = option.hint?.isEmpty == false ? " — \(option.hint!)" : ""
        print("  [\(idx + 1)] \(option.label)\(hint)")
    }
    let initialIndices: [Int]
    if multiple {
        let initialValues = anyCodableArray(step.initialvalue)
        initialIndices = options.enumerated().compactMap { index, option in
            initialValues.contains { anyCodableEqual($0, option.value) } ? index + 1 : nil
        }
    } else {
        initialIndices = options.firstIndex(where: { anyCodableEqual($0.value, step.initialvalue) })
            .map { [$0 + 1] } ?? []
    }
    let defaultLabel = initialIndices.isEmpty ? "" : " [\(initialIndices.map(String.init).joined(separator: ","))]"
    let prompt = multiple ? "Select (comma-separated)" : "Select one"
    while true {
        let input = try readLineWithPrompt("\(prompt)\(defaultLabel)")
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty, multiple || !initialIndices.isEmpty {
            return initialIndices.map { options[$0 - 1].value?.value ?? options[$0 - 1].label }
        }
        if trimmed.lowercased() == "q" { throw WizardCliError.cancelled }
        let parts = multiple
            ? trimmed.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            : [trimmed]
        let indices = parts.compactMap { Int($0) }.filter { (1...options.count).contains($0) }
        if indices.isEmpty {
            print("Invalid selection.")
            continue
        }
        return indices.map { options[$0 - 1].value?.value ?? options[$0 - 1].label }
    }
}

private func readLineWithPrompt(_ prompt: String) throws -> String {
    print("\(prompt): ", terminator: "")
    guard let line = readLine() else {
        throw WizardCliError.cancelled
    }
    return line
}

private func readSensitiveLineWithPrompt(_ prompt: String) throws -> String {
    print("\(prompt): ", terminator: "")
    fflush(stdout)

    var original = termios()
    guard tcgetattr(STDIN_FILENO, &original) == 0 else {
        throw WizardCliError.gatewayError("Could not configure hidden terminal input.")
    }

    var hidden = original
    hidden.c_lflag &= ~tcflag_t(ECHO)
    guard tcsetattr(STDIN_FILENO, TCSANOW, &hidden) == 0 else {
        throw WizardCliError.gatewayError("Could not configure hidden terminal input.")
    }
    defer {
        _ = tcsetattr(STDIN_FILENO, TCSANOW, &original)
        print("")
    }

    guard let line = readLine() else {
        throw WizardCliError.cancelled
    }
    return line
}
