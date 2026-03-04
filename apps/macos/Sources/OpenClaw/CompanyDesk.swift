import AppKit
import Foundation
import OpenClawChatUI
import OpenClawProtocol
import SwiftUI

private enum CompanyDeskKeys {
    static func home(agentId: String) -> String { "agent:\(agentId):desk:v1:main" }
    static func thread(agentId: String, slug: String) -> String { "agent:\(agentId):desk:v1:thread:\(slug)" }
    static func inbox(agentId: String) -> String { "agent:\(agentId):phone:v1:inbox" }
    static func sent(agentId: String) -> String { "agent:\(agentId):phone:v1:sent" }
}

struct CompanyDeskThread: Identifiable, Hashable {
    let id: String
    let slug: String
    let sessionKey: String

    var title: String {
        if self.slug == "main" { return "main" }
        return self.slug
    }
}

@MainActor
final class CompanyDeskViewModel: ObservableObject {
    @Published var agents: [String] = []
    @Published var selectedAgent: String = ""
    @Published var threads: [CompanyDeskThread] = []
    @Published var selectedThread: CompanyDeskThread?
    @Published var newThreadName: String = ""
    @Published var selectedPhoneTarget: String = ""
    @Published var phoneThread: String = "main"
    @Published var phoneBody: String = ""
    @Published var statusLine: String = ""

    var selectedSessionKey: String {
        self.selectedThread?.sessionKey ?? CompanyDeskKeys.home(agentId: self.selectedAgent)
    }

    var availablePhoneTargets: [String] {
        self.agents.filter { $0 != self.selectedAgent }
    }

    var sanitizedThreadSlug: String {
        let slug = Self.slugify(self.phoneThread)
        return slug.isEmpty ? "main" : slug
    }

    var canCreateThread: Bool {
        !Self.slugify(self.newThreadName).isEmpty
    }

    var canSendPhoneMessage: Bool {
        !self.selectedAgent.isEmpty &&
            !self.selectedPhoneTarget.isEmpty &&
            self.selectedPhoneTarget != self.selectedAgent &&
            !self.phoneBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func normalizePhoneTarget() {
        if self.selectedPhoneTarget == self.selectedAgent || !self.agents.contains(self.selectedPhoneTarget) {
            self.selectedPhoneTarget = self.availablePhoneTargets.first ?? ""
        }
    }

    func load() {
        Task {
            await self.loadAgents()
            await self.refreshThreads()
        }
    }

    func loadAgents() async {
        do {
            let data = try await GatewayConnection.shared.requestRaw(method: "config.get", params: nil, timeoutMs: 15000)
            let ids = Self.extractAgentIds(fromConfigGet: data)
            self.agents = ids
            if self.selectedAgent.isEmpty || !ids.contains(self.selectedAgent) {
                self.selectedAgent = ids.first ?? "main"
            }
            if self.selectedPhoneTarget.isEmpty || !ids.contains(self.selectedPhoneTarget) {
                self.selectedPhoneTarget = ids.first(where: { $0 != self.selectedAgent }) ?? ""
            }
            self.normalizePhoneTarget()
        } catch {
            self.statusLine = "config.get failed: \(error.localizedDescription)"
        }
    }

    func refreshThreads() async {
        guard !self.selectedAgent.isEmpty else { return }
        self.normalizePhoneTarget()
        do {
            let data = try await GatewayConnection.shared.request(
                method: "sessions.list",
                params: [
                    "limit": AnyCodable(500),
                    "includeGlobal": AnyCodable(true),
                    "includeUnknown": AnyCodable(true),
                ],
                timeoutMs: 15000)
            let response = try JSONDecoder().decode(GatewaySessionsListResponse.self, from: data)
            let prefix = "agent:\(self.selectedAgent):desk:v1:"
            var found = response.sessions
                .map(\.key)
                .filter { $0.hasPrefix(prefix) }
                .compactMap { key -> CompanyDeskThread? in
                    if key == CompanyDeskKeys.home(agentId: self.selectedAgent) {
                        return CompanyDeskThread(id: key, slug: "main", sessionKey: key)
                    }
                    let marker = "agent:\(self.selectedAgent):desk:v1:thread:"
                    guard key.hasPrefix(marker) else { return nil }
                    return CompanyDeskThread(id: key, slug: String(key.dropFirst(marker.count)), sessionKey: key)
                }
            if !found.contains(where: { $0.slug == "main" }) {
                found.append(CompanyDeskThread(
                    id: CompanyDeskKeys.home(agentId: self.selectedAgent),
                    slug: "main",
                    sessionKey: CompanyDeskKeys.home(agentId: self.selectedAgent)))
            }
            found.sort { $0.slug < $1.slug }
            self.threads = found
            if let current = self.selectedThread, found.contains(current) {
                self.selectedThread = current
            } else {
                self.selectedThread = found.first(where: { $0.slug == "main" }) ?? found.first
            }
            self.statusLine = ""
        } catch {
            self.statusLine = "sessions.list failed: \(error.localizedDescription)"
        }
    }

    func createThread() async {
        guard !self.selectedAgent.isEmpty else {
            self.statusLine = "Select an agent first"
            return
        }
        let slug = Self.slugify(self.newThreadName)
        guard !slug.isEmpty else {
            self.statusLine = "Thread name must contain letters or numbers"
            return
        }
        if self.threads.contains(where: { $0.slug == slug }) {
            self.statusLine = "Thread '\(slug)' already exists"
            return
        }
        let sessionKey = CompanyDeskKeys.thread(agentId: self.selectedAgent, slug: slug)
        do {
            _ = try await ControlChannel.shared.request(
                method: "sessions.patch",
                params: [
                    "sessionKey": AnyCodable(sessionKey),
                    "displayName": AnyCodable("\(self.selectedAgent) • \(slug)"),
                ])
            self.newThreadName = ""
            await self.refreshThreads()
            self.selectedThread = self.threads.first(where: { $0.sessionKey == sessionKey })
            self.statusLine = "Created thread '\(slug)'"
        } catch {
            self.statusLine = "sessions.patch failed: \(error.localizedDescription)"
        }
    }

    func sendPhoneMessage() async {
        let from = self.selectedAgent
        let to = self.selectedPhoneTarget
        guard !from.isEmpty else {
            self.statusLine = "Select a sender agent"
            return
        }
        guard !to.isEmpty else {
            self.statusLine = "Select a destination agent"
            return
        }
        guard from != to else {
            self.statusLine = "Sender and destination must be different"
            return
        }
        let body = self.phoneBody.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else {
            self.statusLine = "Message body is empty"
            return
        }
        let thread = self.sanitizedThreadSlug
        let envelope = Self.phoneEnvelope(from: from, to: to, thread: thread, body: body)
        do {
            _ = try await GatewayConnection.shared.chatSend(
                sessionKey: CompanyDeskKeys.inbox(agentId: to),
                message: envelope,
                thinking: "default",
                idempotencyKey: Self.makeSessionKey(),
                attachments: [])
            try await GatewayConnection.shared.chatInject(
                sessionKey: CompanyDeskKeys.sent(agentId: from),
                note: envelope)
            self.statusLine = "Sent \(from) → \(to) on #\(thread)"
            self.phoneBody = ""
        } catch {
            self.statusLine = "Phone send failed \(from) → \(to): \(error.localizedDescription)"
        }
    }

    static func makeSessionKey() -> String {
        UUID().uuidString
    }

    static func phoneEnvelope(from: String, to: String, thread: String, body: String) -> String {
        "FROM=\(from)\nTO=\(to)\nTHREAD=\(thread)\nKIND=internal_sms\n---\n\(body)"
    }

    private static func extractAgentIds(fromConfigGet data: Data) -> [String] {
        guard
            let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let config = root["config"] as? [String: Any],
            let agents = config["agents"] as? [String: Any],
            let list = agents["list"] as? [[String: Any]]
        else { return ["main"] }
        let ids = list.compactMap { $0["id"] as? String }.filter { !$0.isEmpty }
        return ids.isEmpty ? ["main"] : ids
    }

    private static func slugify(_ raw: String) -> String {
        let lower = raw.lowercased()
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let mapped = lower.map { ch -> Character in
            let scalar = String(ch).unicodeScalars.first!
            return allowed.contains(scalar) ? ch : "-"
        }
        let collapsed = String(mapped).replacingOccurrences(of: "--+", with: "-", options: .regularExpression)
        return collapsed.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}

struct CompanyDeskRootView: View {
    @StateObject private var vm = CompanyDeskViewModel()
    @State private var activeTab: Int = 0

    var body: some View {
        VStack(spacing: 0) {
            Picker("Mode", selection: self.$activeTab) {
                Text("Desk").tag(0)
                Text("Phone").tag(1)
            }
            .pickerStyle(.segmented)
            .padding(10)

            if self.activeTab == 0 {
                self.deskView
            } else {
                self.phoneView
            }

            if !self.vm.statusLine.isEmpty {
                Text(self.vm.statusLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 8)
            }
        }
        .frame(minWidth: 980, minHeight: 640)
        .task {
            self.vm.load()
        }
    }

    private var deskView: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Agents").font(.headline)
                List(self.vm.agents, id: \.self, selection: Binding(
                    get: { self.vm.selectedAgent },
                    set: { newValue in
                        self.vm.selectedAgent = newValue
                        Task { await self.vm.refreshThreads() }
                    })) { agent in
                    Text(agent)
                }
            }
            .frame(width: 170)
            .padding(8)

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Threads").font(.headline)
                    Spacer()
                    Button("Refresh") { Task { await self.vm.refreshThreads() } }
                        .controlSize(.small)
                }
                List(self.vm.threads, selection: Binding(
                    get: { self.vm.selectedThread?.id ?? "" },
                    set: { id in self.vm.selectedThread = self.vm.threads.first(where: { $0.id == id }) })) { thread in
                    Text(thread.title).tag(thread.id)
                }
                HStack {
                    TextField("new-thread", text: self.$vm.newThreadName)
                    Button("Create") { Task { await self.vm.createThread() } }
                        .disabled(!self.vm.canCreateThread)
                }
            }
            .frame(width: 220)
            .padding(8)

            Divider()

            OpenClawChatView(
                viewModel: OpenClawChatViewModel(sessionKey: self.vm.selectedSessionKey, transport: MacGatewayChatTransport()),
                showsSessionSwitcher: false,
                userAccent: nil)
        }
    }

    private var phoneView: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("From")
                Picker("From", selection: self.$vm.selectedAgent) {
                    ForEach(self.vm.agents, id: \.self) { a in Text(a).tag(a) }
                }
                .frame(width: 180)
                .onChange(of: self.vm.selectedAgent) { _, _ in
                    self.vm.selectedPhoneTarget = self.vm.availablePhoneTargets.first ?? ""
                    Task { await self.vm.refreshThreads() }
                }

                Text("To")
                Picker("To", selection: self.$vm.selectedPhoneTarget) {
                    if self.vm.availablePhoneTargets.isEmpty {
                        Text("No target").tag("")
                    } else {
                        ForEach(self.vm.availablePhoneTargets, id: \.self) { a in Text(a).tag(a) }
                    }
                }
                .frame(width: 180)

                Text("Thread")
                TextField("main", text: self.$vm.phoneThread)
                    .frame(width: 160)
                Text("slug: #\(self.vm.sanitizedThreadSlug)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            TextEditor(text: self.$vm.phoneBody)
                .frame(minHeight: 180)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator))

            HStack {
                Button("Send A→B") {
                    Task { await self.vm.sendPhoneMessage() }
                }
                .disabled(!self.vm.canSendPhoneMessage)
                Spacer()
            }

            HStack(spacing: 8) {
                OpenClawChatView(
                    viewModel: OpenClawChatViewModel(
                        sessionKey: CompanyDeskKeys.inbox(agentId: self.vm.selectedAgent),
                        transport: MacGatewayChatTransport()),
                    showsSessionSwitcher: false,
                    userAccent: nil)
                OpenClawChatView(
                    viewModel: OpenClawChatViewModel(
                        sessionKey: CompanyDeskKeys.sent(agentId: self.vm.selectedAgent),
                        transport: MacGatewayChatTransport()),
                    showsSessionSwitcher: false,
                    userAccent: nil)
            }
        }
        .padding(10)
    }
}

@MainActor
final class CompanyDeskManager {
    static let shared = CompanyDeskManager()
    private var window: NSWindow?

    func show() {
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let host = NSHostingController(rootView: CompanyDeskRootView())
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 700),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false)
        window.title = "Company Desk"
        window.contentViewController = host
        window.isReleasedWhenClosed = false
        window.center()
        self.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
