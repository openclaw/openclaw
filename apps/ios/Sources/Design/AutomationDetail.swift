import OpenClawKit
import SwiftUI

struct AutomationDetail: View {
    let gateway: AutomationGateway
    let id: String
    let changed: () -> Void
    @State private var job: AutomationGateway.Definition?
    @State private var editing: AutomationGateway.Definition?
    @State private var deletion: AutomationGateway.Definition?
    @State private var advanced = false
    @State private var busy = false
    @State private var message: String?
    @State private var errorText: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            if let job {
                Section {
                    Text(verbatim: job.title).font(OpenClawType.title2SemiBold)
                    if let key = job.instructionsKey,
                       let text = job.payload[key]?.stringValue { Text(verbatim: text).font(OpenClawType.body) }
                    Label { Text(verbatim: job.scheduleLabel).font(OpenClawType.body) } icon: {
                        Image(systemName: "clock")
                    }
                }
                Section {
                    if self.gateway.canManage {
                        Toggle(isOn: Binding(get: { job.enabled }, set: { enabled in
                            self.perform {
                                var params = try job.revisionParams()
                                params["patch"] = .init(["enabled": enabled])
                                self.job = try await self.gateway.read(
                                    AutomationGateway.Definition.self,
                                    "cron.update",
                                    params)
                                self.changed()
                            }
                        })) { Text("Active").font(OpenClawType.body) }.disabled(self.busy || job.configRevision == nil)
                        Button { self.run(job) } label: {
                            Text("Run now").font(OpenClawType.body)
                        }
                        .disabled(self.busy)
                    }
                    NavigationLink { AutomationRuns(gateway: self.gateway, jobID: job.id) } label: {
                        Text("Run history").font(OpenClawType.body)
                    }
                    Button { self.advanced = true } label: { Text("Open in Dashboard").font(OpenClawType.body) }
                } footer: {
                    if let message { Text(verbatim: message).font(OpenClawType.footnote) }
                }
                if self.gateway.canManage {
                    Section {
                        Button(role: .destructive) { self.deletion = job } label: {
                            Text("Delete automation").font(OpenClawType.body)
                        }
                        .disabled(self.busy || job.configRevision == nil)
                    }
                }
            } else if self.errorText == nil { ProgressView() }
            if let errorText { Section { Text(verbatim: errorText).font(OpenClawType.body)
                Button { self.reload() } label: { Text("Refresh").font(OpenClawType.body) }
            } }
        }
        .navigationTitle("Automation").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button { self.dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel(Text("Close"))
            }
            if let job, self.gateway.canManage { ToolbarItem(placement: .primaryAction) {
                Button { self.editing = job } label: { Text("Edit").font(OpenClawType.headline) }
                    .disabled(self.busy || job.configRevision == nil)
            } }
        }
        .task { self.reload() }
        .interactiveDismissDisabled(self.busy)
        .sheet(item: self.$editing) { job in
            AutomationEditor(gateway: self.gateway, job: job, agentID: nil) { self.job = $0
                self.changed()
            }
        }
        .sheet(isPresented: self.$advanced) { DashboardPageScreen(
            path: DashboardRouteMap.cronJobsPagePath,
            title: self.job?.title ?? "",
            queryItems: [URLQueryItem(name: "job", value: self.id)],
            onClose: { self.advanced = false }) }
        .alert(
            "Delete automation?",
            isPresented: Binding(get: { self.deletion != nil }, set: { if !$0 { self.deletion = nil } }),
            presenting: self.deletion)
        { snapshot in
            Button(role: .cancel) {} label: { Text("Cancel").font(OpenClawType.body) }
            Button(role: .destructive) { self.perform {
                let result = try await self.gateway.read(
                    AutomationGateway.RemoveResult.self,
                    "cron.remove",
                    snapshot.revisionParams())
                guard result.removed else { throw AutomationFormError.removed }
                self.changed()
                self.dismiss()
            } } label: { Text("Delete").font(OpenClawType.body) }
        } message: { snapshot in
            Text(verbatim: String(
                format: String(localized: "This deletes “%@” and stops future runs."),
                snapshot.title))
                .font(OpenClawType.body)
        }
    }

    private func reload() {
        self.perform { self.job = try await self.gateway.read(
            AutomationGateway.Definition.self,
            "cron.get",
            ["id": .init(self.id)]) }
    }

    private func run(_ job: AutomationGateway.Definition) {
        self.perform {
            let result = try await self.gateway.read(
                AutomationGateway.RunResult.self,
                "cron.run",
                ["id": .init(job.id), "mode": .init("force")])
            if result.enqueued == true {
                self.message = String(localized: "Run queued.")
            } else if result.ran == true {
                self.message = String(localized: "Run started.")
            } else {
                self.message = result
                    .reason == "already-running" ? String(localized: "This automation is already running.") :
                    String(localized: "The run did not start.")
            }
        }
    }

    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !self.busy else { return }
        self.busy = true
        self.errorText = nil
        self.message = nil
        Task { defer { self.busy = false }
            do { try await action() } catch { self.errorText = error.localizedDescription }
        }
    }
}

private struct AutomationRuns: View {
    let gateway: AutomationGateway
    let jobID: String
    @State private var entries: [AutomationGateway.Runs.Entry] = []
    @State private var nextOffset: Int?
    @State private var loaded = false
    @State private var busy = false
    @State private var errorText: String?
    var body: some View {
        List {
            if let errorText { Text(verbatim: errorText).font(OpenClawType.body)
                Button { Task { await self.load(0) } } label: { Text("Retry").font(OpenClawType.body) }
            } else if !self.loaded {
                ProgressView()
            } else if self.entries.isEmpty {
                ContentUnavailableView {
                    Label { Text("No runs yet").font(OpenClawType.headline) } icon: { Image(systemName: "clock") }
                } description: { Text("Past runs appear here.").font(OpenClawType.body) }
            }
            ForEach(Array(self.entries.enumerated()), id: \.offset) { _, entry in
                VStack(alignment: .leading, spacing: 4) {
                    Text(
                        Date(timeIntervalSince1970: Double(entry.ts) / 1000),
                        format: .dateTime.month().day().hour().minute()).font(OpenClawType.headline)
                    Text(verbatim: Self.label(entry.status)).font(OpenClawType.subheadMedium)
                        .foregroundStyle(.secondary)
                    if let summary = entry.error ?? entry.summary,
                       !summary.isEmpty { Text(verbatim: summary).font(OpenClawType.body) }
                }.padding(.vertical, 3)
            }
            if let offset = self
                .nextOffset
            {
                Button { Task { await self.load(offset) } } label: { Text("Show more").font(OpenClawType.body) }
                    .disabled(self.busy)
            }
        }.navigationTitle("Run history").task { await self.load(0) }.refreshable { await self.load(0) }
    }

    private static func label(_ value: String?) -> String {
        switch value {
        case "ok": String(localized: "Completed")
        case "error": String(localized: "Failed")
        case "skipped": String(localized: "Skipped")
        default: String(localized: "Unknown")
        }
    }

    private func load(_ offset: Int) async {
        guard !self.busy else { return }
        self.busy = true
        defer { self.busy = false }
        do {
            let page = try await self.gateway.read(
                AutomationGateway.Runs.self,
                "cron.runs",
                ["id": .init(self.jobID), "offset": .init(offset), "limit": .init(50), "view": .init("summary")])
            self.entries = offset == 0 ? page.entries : self.entries + page.entries
            self.nextOffset = page.nextOffset
            self.loaded = true
            self.errorText = nil
        } catch { if !Task.isCancelled { self.errorText = error.localizedDescription } }
    }
}
