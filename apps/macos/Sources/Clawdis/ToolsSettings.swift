import AppKit
import SwiftUI

private enum NodePackageManager: String, CaseIterable, Identifiable {
    case npm
    case pnpm
    case bun

    var id: String { self.rawValue }

    var label: String {
        switch self {
        case .npm: "NPM"
        case .pnpm: "PNPM"
        case .bun: "Bun"
        }
    }

    var installCommandPrefix: String {
        switch self {
        case .npm: "npm install -g"
        case .pnpm: "pnpm add -g"
        case .bun: "bun add -g"
        }
    }
}

// MARK: - Data models

private enum InstallMethod: Equatable {
    case brew(formula: String, binary: String)
    case node(package: String, binary: String)
    case go(module: String, binary: String)
    case pnpm(repoPath: String, script: String, binary: String)
    case gitClone(url: String, destination: String)
    case mcporter(name: String, command: String, summary: String)

    var binary: String? {
        switch self {
        case let .brew(_, binary),
             let .node(_, binary),
             let .go(_, binary),
             let .pnpm(_, _, binary):
            binary
        case .gitClone:
            nil
        case .mcporter:
            "mcporter"
        }
    }
}

private struct ToolEntry: Identifiable, Equatable {
    let id: String
    let name: String
    let url: URL
    let description: String
    let method: InstallMethod
    let kind: Kind

    enum Kind: String {
        case tool = "Tools"
        case mcp = "MCP Servers"
    }
}

private enum InstallState: Equatable {
    case checking
    case notInstalled
    case installed
    case installing
    case failed(String)
}

// MARK: - View

struct ToolsSettings: View {
    private let tools: [ToolEntry] = [
        ToolEntry(
            id: "mcporter",
            name: "mcporter",
            url: URL(string: "https://github.com/steipete/mcporter")!,
            description: "MCP runtime/CLI to discover servers, run tools, and sync configs across AI clients.",
            method: .node(package: "mcporter", binary: "mcporter"),
            kind: .tool),
        ToolEntry(
            id: "peekaboo",
            name: "Peekaboo",
            url: URL(string: "https://github.com/steipete/Peekaboo")!,
            description: "Lightning-fast macOS screenshots with AI vision helpers for step-by-step automation.",
            method: .brew(formula: "steipete/tap/peekaboo", binary: "peekaboo"),
            kind: .tool),
        ToolEntry(
            id: "camsnap",
            name: "camsnap",
            url: URL(string: "https://github.com/steipete/camsnap")!,
            description: "One command to grab frames, clips, or motion alerts from RTSP/ONVIF cameras.",
            method: .brew(formula: "steipete/tap/camsnap", binary: "camsnap"),
            kind: .tool),
        ToolEntry(
            id: "oracle",
            name: "oracle",
            url: URL(string: "https://github.com/steipete/oracle")!,
            description: "Runs OpenAI-ready agent workflows from the CLI with session replay and browser control.",
            method: .node(package: "@steipete/oracle", binary: "oracle"),
            kind: .tool),
        ToolEntry(
            id: "qmd",
            name: "qmd",
            url: URL(string: "https://github.com/tobi/qmd")!,
            description: "Hybrid markdown search (BM25 + vectors + rerank) with an MCP server for agents.",
            method: .node(package: "https://github.com/tobi/qmd", binary: "qmd"),
            kind: .tool),
        ToolEntry(
            id: "eightctl",
            name: "eightctl",
            url: URL(string: "https://github.com/steipete/eightctl")!,
            description: "Control Eight Sleep Pods (temp, alarms, schedules, metrics) from scripts or cron.",
            method: .go(module: "github.com/steipete/eightctl/cmd/eightctl@latest", binary: "eightctl"),
            kind: .tool),
        ToolEntry(
            id: "imsg",
            name: "imsg",
            url: URL(string: "https://github.com/steipete/imsg")!,
            description: "CLI for macOS Messages: read/tail chats and send iMessage/SMS with attachments.",
            method: .go(module: "github.com/steipete/imsg/cmd/imsg@latest", binary: "imsg"),
            kind: .tool),
        ToolEntry(
            id: "spotify-player",
            name: "spotify-player",
            url: URL(string: "https://github.com/aome510/spotify-player")!,
            description: "Terminal Spotify client to queue, search, and control playback without leaving chat.",
            method: .brew(formula: "spotify_player", binary: "spotify_player"),
            kind: .tool),
        ToolEntry(
            id: "sag",
            name: "sag",
            url: URL(string: "https://github.com/steipete/sag")!,
            description: "ElevenLabs TTS with mac-style flags; stream to speakers or save audio.",
            method: .brew(formula: "steipete/tap/sag", binary: "sag"),
            kind: .tool),
        ToolEntry(
            id: "openhue-cli",
            name: "OpenHue CLI",
            url: URL(string: "https://github.com/openhue/openhue-cli")!,
            description: "Control Philips Hue lights from scripts—scenes, dimming, and automations.",
            method: .brew(formula: "openhue/cli/openhue-cli", binary: "openhue"),
            kind: .tool),
        ToolEntry(
            id: "gog",
            name: "gog",
            url: URL(string: "https://github.com/steipete/gog")!,
            description: "Unified Google CLI for Gmail, Calendar, Drive, and Contacts. Replaces MCP servers.",
            method: .brew(formula: "steipete/tap/gog", binary: "gog"),
            kind: .tool),
        ToolEntry(
            id: "gemini-cli",
            name: "Gemini CLI",
            url: URL(string: "https://github.com/google-gemini/gemini-cli")!,
            description: "Google Gemini models from the terminal for fast Q&A and web-grounded summaries.",
            method: .brew(formula: "gemini-cli", binary: "gemini"),
            kind: .tool),
        ToolEntry(
            id: "bird",
            name: "bird",
            url: URL(string: "https://github.com/steipete/bird")!,
            description: "Fast X/Twitter CLI to tweet, reply, read threads, and search without a browser.",
            method: .pnpm(
                repoPath: "\(NSHomeDirectory())/Projects/bird",
                script: "binary",
                binary: "bird"),
            kind: .tool),
        ToolEntry(
            id: "agent-tools",
            name: "agent-tools",
            url: URL(string: "https://github.com/badlogic/agent-tools")!,
            description: "Collection of utilities and scripts tuned for autonomous agents and MCP clients.",
            method: .gitClone(
                url: "https://github.com/badlogic/agent-tools.git",
                destination: "\(NSHomeDirectory())/agent-tools"),
            kind: .tool),
    ]

    @AppStorage("tools.packageManager") private var packageManagerRaw = NodePackageManager.npm.rawValue
    @State private var installStates: [String: InstallState] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.packageManagerPicker
            ScrollView {
                LazyVStack(spacing: 12) {
                    self.section(for: .tool, title: "CLI Tools")
                    self.section(for: .mcp, title: "MCP Servers")
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, 12)
        .onChange(of: self.packageManagerRaw) { _, _ in
            self.refreshAll()
        }
        .task { self.refreshAll() }
    }

    private var packageManager: NodePackageManager {
        NodePackageManager(rawValue: self.packageManagerRaw) ?? .npm
    }

    private var packageManagerPicker: some View {
        Picker("Preferred package manager", selection: self.$packageManagerRaw) {
            ForEach(NodePackageManager.allCases) { manager in
                Text(manager.label).tag(manager.rawValue)
            }
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: 340)
        .padding(.top, 2)
    }

    @ViewBuilder
    private func section(for kind: ToolEntry.Kind, title: String) -> some View {
        let filtered = self.tools.filter { $0.kind == kind }
        if filtered.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.callout.weight(.semibold))
                .padding(.top, 6)

            VStack(spacing: 8) {
                ForEach(filtered) { tool in
                    ToolRow(
                        tool: tool,
                        state: self.binding(for: tool),
                        packageManager: self.packageManager,
                        refreshState: { await self.refresh(tool: tool) })
                        .padding(10)
                        .background(Color(nsColor: .controlBackgroundColor))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(Color.secondary.opacity(0.15), lineWidth: 1))
                }
            }
            }
        }
    }

    private func binding(for tool: ToolEntry) -> Binding<InstallState> {
        let current = self.installStates[tool.id] ?? .checking
        return Binding(
            get: { self.installStates[tool.id] ?? current },
            set: { self.installStates[tool.id] = $0 })
    }

    private func refreshAll() {
        Task {
            for tool in self.tools {
                await self.refresh(tool: tool)
            }
        }
    }

    @MainActor
    private func refresh(tool: ToolEntry) async {
        let installed = await ToolInstaller.isInstalled(tool.method, packageManager: self.packageManager)
        self.installStates[tool.id] = installed ? .installed : .notInstalled
    }
}

// MARK: - Row

private struct ToolRow: View {
    let tool: ToolEntry
    @Binding var state: InstallState
    @State private var statusMessage: String?
    @State private var linkHovering = false
    let packageManager: NodePackageManager
    let refreshState: () async -> Void

    private enum Layout {
        // Ensure progress indicators and buttons occupy the same space so the row doesn't shift.
        static let actionWidth: CGFloat = 96
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Link(destination: self.tool.url) {
                        Text(self.tool.name)
                            .font(.headline)
                            .underline(self.linkHovering, color: .accentColor)
                    }
                    .foregroundColor(.accentColor)
                    .onHover { self.linkHovering = $0 }
                    .pointingHandCursor()
                    Text(self.tool.description)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                self.actionButton
            }

            if let statusMessage, !statusMessage.isEmpty {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear { self.refresh() }
    }

    private var actionButton: some View {
        VStack {
            switch self.state {
            case .installed:
                Label("Installed", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.subheadline)
            case .installing:
                ProgressView().controlSize(.small)
            case .failed:
                Button("Retry") { self.install() }
                    .buttonStyle(.borderedProminent)
            case .checking:
                ProgressView().controlSize(.small)
            case .notInstalled:
                Button("Install") { self.install() }
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(width: Layout.actionWidth, alignment: .trailing)
    }

    private func refresh() {
        Task {
            self.state = .checking
            let installed = await ToolInstaller.isInstalled(self.tool.method, packageManager: self.packageManager)
            await MainActor.run {
                self.state = installed ? .installed : .notInstalled
            }
        }
    }

    private func install() {
        Task {
            self.state = .installing
            let result = await ToolInstaller.install(self.tool.method, packageManager: self.packageManager)
            await MainActor.run {
                self.statusMessage = result.message
                self.state = result.installed ? .installed : .failed(result.message)
                if result.installed { Task { await self.refreshState() } }
            }
        }
    }
}

// MARK: - Installer

private enum ToolInstaller {
    struct InstallResult {
        let installed: Bool
        let message: String
    }

    static func isInstalled(_ method: InstallMethod, packageManager: NodePackageManager = .npm) async -> Bool {
        switch method {
        case let .brew(formula, _):
            return await self.shellSucceeds("brew list --versions \(formula)")
        case let .node(_, binary),
             let .go(_, binary),
             let .pnpm(_, _, binary):
            return await self.commandExists(binary)
        case let .gitClone(_, destination):
            return FileManager.default.fileExists(atPath: destination)
        case let .mcporter(name, _, _):
            guard await self.commandExists("mcporter") else { return false }
            return await self.shellSucceeds("mcporter config get \(name) --json")
        }
    }

    static func install(_ method: InstallMethod, packageManager: NodePackageManager = .npm) async -> InstallResult {
        switch method {
        case let .brew(formula, _):
            return await self.runInstall("brew install \(formula)")
        case let .node(package, _):
            return await self.runInstall("\(packageManager.installCommandPrefix) \(package)")
        case let .go(module, _):
            return await self.runInstall("GO111MODULE=on go install \(module)")
        case let .pnpm(repoPath, script, _):
            let cmd = "cd \(escape(repoPath)) && pnpm install && pnpm run \(script)"
            return await self.runInstall(cmd)
        case let .gitClone(url, destination):
            let cmd = """
            if [ -d \(escape(destination)) ]; then
              echo "Already cloned"
            else
              git clone \(url) \(escape(destination))
            fi
            """
            return await self.runInstall(cmd)
        case let .mcporter(name, command, summary):
            let cmd = """
            mcporter config add \(name) --command "\(command)" --transport stdio --scope home --description "\(summary)"
            """
            return await self.runInstall(cmd)
        }
    }

    // MARK: - Helpers

    private static func commandExists(_ binary: String) async -> Bool {
        await self.shellSucceeds("command -v \(binary)")
    }

    private static func shellSucceeds(_ command: String) async -> Bool {
        let status = await run(command).status
        return status == 0
    }

    private static func runInstall(_ command: String) async -> InstallResult {
        let result = await run(command)
        let success = result.status == 0
        let message = result.output.isEmpty ? (success ? "Installed" : "Install failed") : result.output
        return InstallResult(installed: success, message: message.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func escape(_ path: String) -> String {
        "\"\(path.replacingOccurrences(of: "\"", with: "\\\""))\""
    }

    private static func run(_ command: String) async -> (status: Int32, output: String) {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.launchPath = "/bin/zsh"
            process.arguments = ["-lc", command]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            process.terminationHandler = { proc in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8) ?? ""
                continuation.resume(returning: (proc.terminationStatus, output))
            }
            do {
                try process.run()
            } catch {
                continuation.resume(returning: (1, error.localizedDescription))
            }
        }
    }
}

#if DEBUG
struct ToolsSettings_Previews: PreviewProvider {
    static var previews: some View {
        ToolsSettings()
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
