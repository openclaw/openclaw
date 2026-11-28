import SwiftUI

/// The same detail sheet serves both the sidebar and Chat Info.
struct AutomationsScreen: View {
    @Environment(NodeAppModel.self) private var app
    var header: OpenClawSidebarHeaderAction?
    var gatewayID: String?
    var initialJobID: String?
    @State private var client: AutomationGateway?
    @State private var resolved = false
    @State private var retry = 0

    var body: some View {
        Group {
            if let client {
                if let initialJobID {
                    AutomationDetail(gateway: client, id: initialJobID, changed: {})
                } else {
                    AutomationList(gateway: client, agentID: self.app.chatAgentId)
                }
            } else if self.resolved {
                ContentUnavailableView {
                    Label { Text("Connect to view automations").font(OpenClawType.headline) } icon: {
                        Image(systemName: "clock")
                    }
                } actions: { Button { self.retry += 1 } label: { Text("Retry").font(OpenClawType.body) } }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Automations")
        .toolbar {
            if let header { ToolbarItem(placement: .topBarLeading) { OpenClawSidebarControlButton(action: header) } }
        }
        .task(id: self.retry) {
            let client = await AutomationGateway.connected(self.app, gatewayID: self.gatewayID)
            guard !Task.isCancelled else { return }
            self.client = client
            self.resolved = true
        }
    }
}

private struct AutomationList: View {
    let gateway: AutomationGateway
    let agentID: String?
    @State private var jobs: [ChatInfoAutomation] = []
    @State private var revision: String?
    @State private var nextOffset: Int?
    @State private var busy = false
    @State private var errorText: String?
    @State private var showingEditor = false
    @State private var selected: ChatInfoAutomation?
    @AppStorage("automations.didIntroduceScheduling") private var introduced = false

    var body: some View {
        List {
            if !self.introduced, self.gateway.canManage, !self.jobs.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "clock.arrow.circlepath").font(.title2).foregroundStyle(.tint)
                            .accessibilityHidden(true)
                        Text("Put a task on a schedule").font(OpenClawType.headline)
                        Text("Choose what your agent should do and when.")
                            .font(OpenClawType.body).foregroundStyle(.secondary)
                        Button { self.introduced = true } label: { Text("Got it").font(OpenClawType.subheadMedium) }
                            .buttonStyle(.borderless)
                    }.padding(.vertical, 5)
                }
            }
            if let errorText {
                Section { Text(verbatim: errorText).font(OpenClawType.body)
                    Button { Task { await self.load() } } label: { Text("Retry").font(OpenClawType.body) }
                }
            } else if self.revision == nil {
                ProgressView()
            } else if self.jobs.isEmpty {
                ContentUnavailableView {
                    Label { Text("No automations yet").font(OpenClawType.headline) } icon: {
                        Image(systemName: "calendar.badge.clock")
                    }
                } description: {
                    if self.gateway.canManage {
                        Text("Choose what your agent should do and when.").font(OpenClawType.body)
                    }
                } actions: {
                    if self.gateway.canManage {
                        Button { self.showingEditor = true } label: {
                            Text("New automation").font(OpenClawType.headline)
                        }
                    }
                }
            }
            ForEach(self.jobs) { job in
                Button { self.selected = job } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "clock.arrow.circlepath")
                            .foregroundStyle(.secondary).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(verbatim: job.displayName ?? job.name).font(OpenClawType.headline)
                                .foregroundStyle(.primary)
                            if let schedule = job
                                .timing(ChatInfoAutomationSchedule())
                            {
                                Text(verbatim: schedule).font(OpenClawType.subheadMedium).foregroundStyle(.secondary)
                            }
                            if let status = job
                                .status
                            {
                                Text(verbatim: status).font(OpenClawType.footnote).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                    }.padding(.vertical, 4)
                }
            }
            if let offset = self.nextOffset {
                Button { Task { await self.load(offset) } } label: { Text("Show more").font(OpenClawType.body) }
                    .disabled(self.busy)
            }
        }
        .navigationTitle("Automations").refreshable { await self.load() }.task { await self.load() }
        .toolbar {
            if self.gateway.canManage, !self.jobs.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { self.showingEditor = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel(Text("New automation"))
                }
            }
        }
        .sheet(isPresented: self.$showingEditor) {
            AutomationEditor(gateway: self.gateway, agentID: self.agentID) { _ in self.introduced = true
                Task { await self.load() }
            }
        }
        .sheet(item: self.$selected) { job in
            NavigationStack { AutomationDetail(
                gateway: self.gateway,
                id: job.id,
                changed: { Task { await self.load() } }) }
        }
    }

    private func load(_ offset: Int = 0) async {
        guard !self.busy else { return }
        self.busy = true
        defer { self.busy = false }
        do {
            var params: AutomationGateway.Params = [
                "compact": .init(true),
                "includeDisabled": .init(true),
                "limit": .init(100),
                "offset": .init(offset),
                "sortBy": .init("name"),
                "sortDir": .init("asc"),
            ]
            if let agentID { params["agentId"] = .init(agentID) }
            let page = try await self.gateway.read(AutomationGateway.Page.self, "cron.list", params)
            guard !page.hasMore || (page.nextOffset ?? 0) > offset,
                  offset == 0 || self.revision == page.snapshotRevision
            else { self.nextOffset = nil
                throw AutomationFormError.changed
            }
            self.jobs = offset == 0 ? page.jobs : self.jobs + page.jobs
            self.revision = page.snapshotRevision
            self.nextOffset = page.hasMore ? page.nextOffset : nil
            self.errorText = nil
        } catch { if !Task.isCancelled { self.errorText = error.localizedDescription } }
    }
}
