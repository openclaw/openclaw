import Darwin
import Dispatch
import Foundation

// launchd starts this signed executable and keeps it alive while the Gateway runs.
// Replacing this process with Bun would lose the app's responsible-code ancestry.
struct AppGatewayServiceCommand {
    let executable: URL
    let arguments: [String]

    init?(arguments: [String], homeDirectory: URL) {
        let home = homeDirectory.standardizedFileURL.path
        let shellWrapper = arguments.first == "/bin/sh"
        let directWrapper = arguments.first?.hasSuffix("-env-wrapper.sh") == true
        let wrapperCount = shellWrapper ? 3 : directWrapper ? 2 : 0
        let command = Array(arguments.dropFirst(wrapperCount))
        guard command.count >= 3 else { return nil }
        let bun = URL(fileURLWithPath: command[0]).standardizedFileURL.path
        let marker = "/runtime/service/bun"
        guard command[0] == bun, bun.hasSuffix(marker) else { return nil }
        let root = String(bun.dropLast(marker.count))
        guard root.hasPrefix(home + "/") else { return nil }
        let stateName = String(root.dropFirst(home.count + 1))
        let profile = stateName.dropFirst(".openclaw-".count)
        guard stateName == ".openclaw" ||
            (stateName.hasPrefix(".openclaw-") &&
                profile.utf8.count <= 64 && profile.first.map({
                    $0.isASCII && ($0.isLetter || $0.isNumber)
                }) == true &&
                profile.allSatisfy({
                    $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_")
                }))
        else { return nil }
        let entryIndex = command[1] == "--no-install" ? 2 : 1
        let entry = URL(fileURLWithPath: command[entryIndex]).standardizedFileURL.path
        guard command.count > entryIndex + 1,
              command[entryIndex] == entry,
              entry.hasPrefix(root + "/runtime/"),
              entry.hasSuffix("/lib/node_modules/openclaw/openclaw.mjs"),
              command[entryIndex + 1] == "gateway"
        else { return nil }
        if wrapperCount > 0 {
            let wrapperIndex = shellWrapper ? 1 : 0
            let fileIndex = wrapperIndex + 1
            let file = arguments[fileIndex]
            guard URL(fileURLWithPath: file).standardizedFileURL.path == file,
                  arguments[wrapperIndex] == root + "/service-env/" + URL(fileURLWithPath: file)
                      .deletingPathExtension().lastPathComponent + "-env-wrapper.sh",
                  file.hasPrefix(root + "/service-env/"), file.hasSuffix(".env")
            else { return nil }
        }
        self.executable = URL(fileURLWithPath: shellWrapper ? "/bin/sh" : directWrapper ? arguments[0] : bun)
        self.arguments = Array(arguments.dropFirst())
    }
}

func runAppGatewayService(_ arguments: [String]) -> Int32 {
    guard let command = AppGatewayServiceCommand(
        arguments: arguments, homeDirectory: FileManager.default.homeDirectoryForCurrentUser)
    else {
        fputs("openclaw-mac: invalid managed Gateway command; reinstall the service\n", stderr)
        return 78
    }
    let child = Process()
    child.executableURL = command.executable
    child.arguments = command.arguments
    do { try child.run() } catch {
        fputs("openclaw-mac: Gateway failed to start: \(error.localizedDescription)\n", stderr)
        return 78
    }
    // launchd signals the helper; forward termination to the Gateway before reaping it.
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let signals = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
        let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
        source.setEventHandler { if child.isRunning { kill(child.processIdentifier, number) } }
        source.resume()
        return source
    }
    child.waitUntilExit()
    signals.forEach { $0.cancel() }
    return child.terminationReason == .uncaughtSignal ? 128 + child.terminationStatus : child.terminationStatus
}
