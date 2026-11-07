import AppKit
import CoreServices
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized, .testWaitLimit)
@MainActor
struct SessionActionsTests {
    @Test func `session log opens in the registered editor without its command line tool`() async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let receipt = root.appendingPathComponent("opened-transcript")
        let editor = root.appendingPathComponent("SessionLogEditor.app")
        let script = root.appendingPathComponent("editor.applescript")
        try """
        on open incomingFiles
            set outputFile to open for access POSIX file "\(receipt.path)" with write permission
            set eof outputFile to 0
            write (POSIX path of (item 1 of incomingFiles)) to outputFile
            close access outputFile
            quit
        end open
        """.write(to: script, atomically: true, encoding: .utf8)
        try Self.run("/usr/bin/osacompile", ["-o", editor.path, script.path])
        let plist = editor.appendingPathComponent("Contents/Info.plist")
        var info = try #require(PropertyListSerialization.propertyList(
            from: Data(contentsOf: plist), format: nil) as? [String: Any])
        info["CFBundleIdentifier"] = "com.microsoft.VSCode"
        info["CFBundleVersion"] = "9999999"
        info["CFBundleShortVersionString"] = "9999999"
        info["LSUIElement"] = true
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: plist)
        try Self.run("/usr/bin/codesign", ["--force", "--sign", "-", editor.path])
        try #require(LSRegisterURL(editor as CFURL, true) == noErr)
        defer {
            for app in NSRunningApplication.runningApplications(withBundleIdentifier: "com.microsoft.VSCode")
                where app.bundleURL?.resolvingSymlinksInPath().path == editor.resolvingSymlinksInPath().path
            {
                app.terminate()
            }
        }
        try #require(
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode")?
                .resolvingSymlinksInPath().path == editor.resolvingSymlinksInPath().path,
            "Launch Services must select the disposable editor fixture")
        let sessionID = UUID().uuidString
        let transcript = root.appendingPathComponent("\(sessionID).jsonl")
        try "{\"type\":\"session\",\"id\":\"synthetic-session-log\"}\n".write(
            to: transcript, atomically: true, encoding: .utf8)
        try await TestIsolation.withIsolatedState(env: ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]) {
            _ = AppKitTestSupport.application
            SessionActions.openSessionLogInCode(
                sessionId: sessionID, storePath: root.appendingPathComponent("sessions.json").path)
            try await TestWait.state("registered editor receives the selected transcript") {
                (try? String(contentsOf: receipt, encoding: .utf8)) == transcript.path
            }
        }
    }

    private static func run(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        let errors = Pipe()
        process.standardError = errors
        try process.run()
        let diagnostic = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        try #require(
            process.terminationStatus == 0,
            Comment(rawValue: String(bytes: diagnostic, encoding: .utf8) ?? "Invalid UTF-8 process diagnostic"))
    }
}
