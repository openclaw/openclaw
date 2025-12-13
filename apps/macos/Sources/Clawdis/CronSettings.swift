import SwiftUI

struct CronSettings: View {
    @ObservedObject var store: CronJobsStore
    @State private var showEditor = false
    @State private var editingJob: CronJob?
    @State private var editorError: String?
    @State private var isSaving = false
    @State private var confirmDelete: CronJob?

    init(store: CronJobsStore = .shared) {
        self.store = store
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.header
            self.schedulerBanner
            self.content
            Spacer(minLength: 0)
        }
        .onAppear { self.store.start() }
        .onDisappear { self.store.stop() }
        .sheet(isPresented: self.$showEditor) {
            CronJobEditor(
                job: self.editingJob,
                isSaving: self.$isSaving,
                error: self.$editorError,
                onCancel: {
                    self.showEditor = false
                    self.editingJob = nil
                },
                onSave: { payload in
                    Task {
                        await self.save(payload: payload)
                    }
                })
        }
        .alert("Delete cron job?", isPresented: Binding(
            get: { self.confirmDelete != nil },
            set: { if !$0 { self.confirmDelete = nil } }))
        {
            Button("Cancel", role: .cancel) { self.confirmDelete = nil }
            Button("Delete", role: .destructive) {
                if let job = self.confirmDelete {
                    Task { await self.store.removeJob(id: job.id) }
                }
                self.confirmDelete = nil
            }
        } message: {
            if let job = self.confirmDelete {
                Text(job.displayName)
            }
        }
        .onChange(of: self.store.selectedJobId) { _, newValue in
                guard let newValue else { return }
                Task { await self.store.refreshRuns(jobId: newValue) }
            }
    }

    private var schedulerBanner: some View {
        Group {
            if self.store.schedulerEnabled == false {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text("Cron scheduler is disabled")
                            .font(.headline)
                        Spacer()
                    }
                    Text(
                        "Jobs are saved, but they will not run automatically until `cron.enabled` is set to `true` and the Gateway restarts.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let storePath = self.store.schedulerStorePath, !storePath.isEmpty {
                        Text(storePath)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Color.orange.opacity(0.10))
                .cornerRadius(8)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Cron")
                    .font(.headline)
                Text("Manage Gateway cron jobs (main session vs isolated runs) and inspect run history.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            HStack(spacing: 8) {
                Button {
                    Task { await self.store.refreshJobs() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(self.store.isLoadingJobs)

                Button {
                    self.editorError = nil
                    self.editingJob = nil
                    self.showEditor = true
                } label: {
                    Label("New Job", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    private var content: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                if let err = self.store.lastError {
                    Text("Error: \(err)")
                        .font(.footnote)
                        .foregroundStyle(.red)
                } else if let msg = self.store.statusMessage {
                    Text(msg)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                List(selection: self.$store.selectedJobId) {
                    ForEach(self.store.jobs) { job in
                        self.jobRow(job)
                            .tag(job.id)
                            .contextMenu { self.jobContextMenu(job) }
                    }
                }
                .listStyle(.inset)
            }
            .frame(width: 250)

            Divider()

            self.detail
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let selected = self.selectedJob {
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 12) {
                    self.detailHeader(selected)
                    self.detailCard(selected)
                    self.runHistoryCard(selected)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 2)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("Select a job to inspect details and run history.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text("Tip: use ‘New Job’ to add one, or enable cron in your gateway config.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.top, 8)
        }
    }

    private var selectedJob: CronJob? {
        guard let id = self.store.selectedJobId else { return nil }
        return self.store.jobs.first(where: { $0.id == id })
    }

    private func jobRow(_ job: CronJob) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(job.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                if !job.enabled {
                    StatusPill(text: "disabled", tint: .secondary)
                } else if let next = job.nextRunDate {
                    StatusPill(text: self.nextRunLabel(next), tint: .secondary)
                } else {
                    StatusPill(text: "no next run", tint: .secondary)
                }
            }
            HStack(spacing: 6) {
                StatusPill(text: job.sessionTarget.rawValue, tint: .secondary)
                StatusPill(text: job.wakeMode.rawValue, tint: .secondary)
                if let status = job.state.lastStatus {
                    StatusPill(text: status, tint: status == "ok" ? .green : .orange)
                }
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private func jobContextMenu(_ job: CronJob) -> some View {
        Button("Run now") { Task { await self.store.runJob(id: job.id, force: true) } }
        if job.sessionTarget == .isolated {
            Button("Open transcript") {
                WebChatManager.shared.show(sessionKey: "cron:\(job.id)")
            }
        }
        Divider()
        Button(job.enabled ? "Disable" : "Enable") {
            Task { await self.store.setJobEnabled(id: job.id, enabled: !job.enabled) }
        }
        Button("Edit…") {
            self.editingJob = job
            self.editorError = nil
            self.showEditor = true
        }
        Divider()
        Button("Delete…", role: .destructive) {
            self.confirmDelete = job
        }
    }

    private func detailHeader(_ job: CronJob) -> some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text(job.displayName)
                    .font(.title3.weight(.semibold))
                Text(job.id)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            HStack(spacing: 8) {
                Toggle("Enabled", isOn: Binding(
                    get: { job.enabled },
                    set: { enabled in Task { await self.store.setJobEnabled(id: job.id, enabled: enabled) } }))
                    .toggleStyle(.switch)
                    .labelsHidden()
                Button("Run") { Task { await self.store.runJob(id: job.id, force: true) } }
                    .buttonStyle(.borderedProminent)
                if job.sessionTarget == .isolated {
                    Button("Transcript") {
                        WebChatManager.shared.show(sessionKey: "cron:\(job.id)")
                    }
                    .buttonStyle(.bordered)
                }
                Button("Edit") {
                    self.editingJob = job
                    self.editorError = nil
                    self.showEditor = true
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private func detailCard(_ job: CronJob) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            LabeledContent("Schedule") { Text(self.scheduleSummary(job.schedule)).font(.callout) }
            LabeledContent("Session") { Text(job.sessionTarget.rawValue) }
            LabeledContent("Wake") { Text(job.wakeMode.rawValue) }
            LabeledContent("Next run") {
                if let date = job.nextRunDate {
                    Text(date.formatted(date: .abbreviated, time: .standard))
                } else {
                    Text("—").foregroundStyle(.secondary)
                }
            }
            LabeledContent("Last run") {
                if let date = job.lastRunDate {
                    Text("\(date.formatted(date: .abbreviated, time: .standard)) · \(relativeAge(from: date))")
                } else {
                    Text("—").foregroundStyle(.secondary)
                }
            }
            if let status = job.state.lastStatus {
                LabeledContent("Last status") { Text(status) }
            }
            if let err = job.state.lastError, !err.isEmpty {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
            }
            self.payloadSummary(job.payload)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.secondary.opacity(0.06))
        .cornerRadius(8)
    }

    private func runHistoryCard(_ job: CronJob) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Run history")
                    .font(.headline)
                Spacer()
                Button {
                    Task { await self.store.refreshRuns(jobId: job.id) }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(self.store.isLoadingRuns)
            }

            if self.store.isLoadingRuns {
                ProgressView().controlSize(.small)
            }

            if self.store.runEntries.isEmpty {
                Text("No run log entries yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(self.store.runEntries) { entry in
                        self.runRow(entry)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.secondary.opacity(0.06))
        .cornerRadius(8)
    }

    private func runRow(_ entry: CronRunLogEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                StatusPill(text: entry.status ?? "unknown", tint: self.statusTint(entry.status))
                Text(entry.date.formatted(date: .abbreviated, time: .standard))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if let ms = entry.durationMs {
                    Text("\(ms)ms")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            if let summary = entry.summary, !summary.isEmpty {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(2)
            }
            if let error = entry.error, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }

    private func statusTint(_ status: String?) -> Color {
        switch (status ?? "").lowercased() {
        case "ok": .green
        case "error": .red
        case "skipped": .orange
        default: .secondary
        }
    }

    private func scheduleSummary(_ schedule: CronSchedule) -> String {
        switch schedule {
        case let .at(atMs):
            let date = Date(timeIntervalSince1970: TimeInterval(atMs) / 1000)
            return "at \(date.formatted(date: .abbreviated, time: .standard))"
        case let .every(everyMs, _):
            return "every \(self.formatDuration(ms: everyMs))"
        case let .cron(expr, tz):
            if let tz, !tz.isEmpty { return "cron \(expr) (\(tz))" }
            return "cron \(expr)"
        }
    }

    private func payloadSummary(_ payload: CronPayload) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Payload")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            switch payload {
            case let .systemEvent(text):
                Text(text)
                    .font(.callout)
                    .textSelection(.enabled)
            case let .agentTurn(message, thinking, timeoutSeconds, deliver, channel, to, _):
                VStack(alignment: .leading, spacing: 4) {
                    Text(message)
                        .font(.callout)
                        .textSelection(.enabled)
                    HStack(spacing: 8) {
                        if let thinking, !thinking.isEmpty { StatusPill(text: "think \(thinking)", tint: .secondary) }
                        if let timeoutSeconds { StatusPill(text: "\(timeoutSeconds)s", tint: .secondary) }
                        if deliver ?? false {
                            StatusPill(text: "deliver", tint: .secondary)
                            if let channel, !channel.isEmpty { StatusPill(text: channel, tint: .secondary) }
                            if let to, !to.isEmpty { StatusPill(text: to, tint: .secondary) }
                        }
                    }
                }
            }
        }
    }

    private func formatDuration(ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        let s = Double(ms) / 1000.0
        if s < 60 { return "\(Int(round(s)))s" }
        let m = s / 60.0
        if m < 60 { return "\(Int(round(m)))m" }
        let h = m / 60.0
        if h < 48 { return "\(Int(round(h)))h" }
        let d = h / 24.0
        return "\(Int(round(d)))d"
    }

    private func nextRunLabel(_ date: Date, now: Date = .init()) -> String {
        let delta = date.timeIntervalSince(now)
        if delta <= 0 { return "due" }
        if delta < 60 { return "in <1m" }
        let minutes = Int(round(delta / 60))
        if minutes < 60 { return "in \(minutes)m" }
        let hours = Int(round(Double(minutes) / 60))
        if hours < 48 { return "in \(hours)h" }
        let days = Int(round(Double(hours) / 24))
        return "in \(days)d"
    }

    private func save(payload: [String: Any]) async {
        guard !self.isSaving else { return }
        self.isSaving = true
        self.editorError = nil
        do {
            try await self.store.upsertJob(id: self.editingJob?.id, payload: payload)
            await MainActor.run {
                self.isSaving = false
                self.showEditor = false
                self.editingJob = nil
            }
        } catch {
            await MainActor.run {
                self.isSaving = false
                self.editorError = error.localizedDescription
            }
        }
    }
}

private struct StatusPill: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(self.text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .foregroundStyle(self.tint == .secondary ? .secondary : self.tint)
            .background((self.tint == .secondary ? Color.secondary : self.tint).opacity(0.12))
            .clipShape(Capsule())
    }
}

private struct CronJobEditor: View {
    let job: CronJob?
    @Binding var isSaving: Bool
    @Binding var error: String?
    let onCancel: () -> Void
    let onSave: ([String: Any]) -> Void

    @State private var name: String = ""
    @State private var enabled: Bool = true
    @State private var sessionTarget: CronSessionTarget = .main
    @State private var wakeMode: CronWakeMode = .nextHeartbeat

    enum ScheduleKind: String, CaseIterable, Identifiable { case at, every, cron; var id: String { rawValue } }
    @State private var scheduleKind: ScheduleKind = .every
    @State private var atDate: Date = .init().addingTimeInterval(60 * 5)
    @State private var everyText: String = "1h"
    @State private var cronExpr: String = "0 9 * * 3"
    @State private var cronTz: String = ""

    enum PayloadKind: String, CaseIterable, Identifiable { case systemEvent, agentTurn; var id: String { rawValue } }
    @State private var payloadKind: PayloadKind = .systemEvent
    @State private var systemEventText: String = ""
    @State private var agentMessage: String = ""
    @State private var deliver: Bool = false
    @State private var channel: String = "last"
    @State private var to: String = ""
    @State private var thinking: String = ""
    @State private var timeoutSeconds: String = ""
    @State private var bestEffortDeliver: Bool = false
    @State private var postPrefix: String = "Cron"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(self.job == nil ? "New cron job" : "Edit cron job")
                    .font(.title3.weight(.semibold))
                Spacer()
            }

            Form {
                Section("Basics") {
                    TextField("Name (optional)", text: self.$name)
                    Toggle("Enabled", isOn: self.$enabled)
                    Picker("Session target", selection: self.$sessionTarget) {
                        Text("main").tag(CronSessionTarget.main)
                        Text("isolated").tag(CronSessionTarget.isolated)
                    }
                    Picker("Wake mode", selection: self.$wakeMode) {
                        Text("next-heartbeat").tag(CronWakeMode.nextHeartbeat)
                        Text("now").tag(CronWakeMode.now)
                    }
                }

                Section("Schedule") {
                    Picker("Kind", selection: self.$scheduleKind) {
                        Text("at").tag(ScheduleKind.at)
                        Text("every").tag(ScheduleKind.every)
                        Text("cron").tag(ScheduleKind.cron)
                    }
                    .pickerStyle(.segmented)

                    switch self.scheduleKind {
                    case .at:
                        DatePicker("At", selection: self.$atDate, displayedComponents: [.date, .hourAndMinute])
                    case .every:
                        TextField("Every (e.g. 10m, 1h, 1d)", text: self.$everyText)
                            .textFieldStyle(.roundedBorder)
                    case .cron:
                        TextField("Cron expr (5-field)", text: self.$cronExpr)
                            .textFieldStyle(.roundedBorder)
                        TextField("Timezone (optional)", text: self.$cronTz)
                            .textFieldStyle(.roundedBorder)
                    }
                }

                Section("Payload") {
                    if self.sessionTarget == .isolated {
                        Text("Isolated jobs always run an agent turn.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        self.agentTurnEditor
                    } else {
                        Picker("Kind", selection: self.$payloadKind) {
                            Text("systemEvent").tag(PayloadKind.systemEvent)
                            Text("agentTurn").tag(PayloadKind.agentTurn)
                        }
                        .pickerStyle(.segmented)

                        switch self.payloadKind {
                        case .systemEvent:
                            TextField("System event text", text: self.$systemEventText, axis: .vertical)
                                .lineLimit(3...6)
                        case .agentTurn:
                            self.agentTurnEditor
                        }
                    }
                }

                if self.sessionTarget == .isolated {
                    Section("Main session summary") {
                        Text("Isolated jobs always post a summary back into the main session when they finish.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextField("Prefix", text: self.$postPrefix)
                    }
                }
            }
            .frame(minWidth: 560, minHeight: 520)

            if let error, !error.isEmpty {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }

            HStack {
                Button("Cancel") { self.onCancel() }
                    .buttonStyle(.bordered)
                Spacer()
                Button {
                    self.save()
                } label: {
                    if self.isSaving {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Save")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.isSaving)
            }
        }
        .padding(18)
        .onAppear { self.hydrateFromJob() }
        .onChange(of: self.payloadKind) { _, newValue in
            if newValue == .agentTurn, self.sessionTarget == .main {
                self.sessionTarget = .isolated
            }
        }
        .onChange(of: self.sessionTarget) { _, newValue in
            if newValue == .isolated {
                self.payloadKind = .agentTurn
            } else if newValue == .main, self.payloadKind == .agentTurn {
                self.payloadKind = .systemEvent
            }
        }
    }

    private var agentTurnEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Agent message", text: self.$agentMessage, axis: .vertical)
                .lineLimit(3...6)
            TextField("Thinking (optional)", text: self.$thinking)
            TextField("Timeout seconds (optional)", text: self.$timeoutSeconds)
                .textFieldStyle(.roundedBorder)
            Toggle("Deliver result", isOn: self.$deliver)
            if self.deliver {
                Picker("Channel", selection: self.$channel) {
                    Text("last").tag("last")
                    Text("whatsapp").tag("whatsapp")
                    Text("telegram").tag("telegram")
                }
                TextField("To (optional)", text: self.$to)
                Toggle("Best-effort deliver", isOn: self.$bestEffortDeliver)
            }
        }
    }

    private func hydrateFromJob() {
        guard let job else { return }
        self.name = job.name ?? ""
        self.enabled = job.enabled
        self.sessionTarget = job.sessionTarget
        self.wakeMode = job.wakeMode

        switch job.schedule {
        case let .at(atMs):
            self.scheduleKind = .at
            self.atDate = Date(timeIntervalSince1970: TimeInterval(atMs) / 1000)
        case let .every(everyMs, _):
            self.scheduleKind = .every
            self.everyText = self.formatDuration(ms: everyMs)
        case let .cron(expr, tz):
            self.scheduleKind = .cron
            self.cronExpr = expr
            self.cronTz = tz ?? ""
        }

        switch job.payload {
        case let .systemEvent(text):
            self.payloadKind = .systemEvent
            self.systemEventText = text
        case let .agentTurn(message, thinking, timeoutSeconds, deliver, channel, to, bestEffortDeliver):
            self.payloadKind = .agentTurn
            self.agentMessage = message
            self.thinking = thinking ?? ""
            self.timeoutSeconds = timeoutSeconds.map(String.init) ?? ""
            self.deliver = deliver ?? false
            self.channel = channel ?? "last"
            self.to = to ?? ""
            self.bestEffortDeliver = bestEffortDeliver ?? false
        }

        self.postPrefix = job.isolation?.postToMainPrefix ?? "Cron"
    }

    private func save() {
        do {
            self.error = nil
            let payload = try self.buildPayload()
            self.onSave(payload)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func buildPayload() throws -> [String: Any] {
        let name = self.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let schedule: [String: Any]
        switch self.scheduleKind {
        case .at:
            schedule = ["kind": "at", "atMs": Int(self.atDate.timeIntervalSince1970 * 1000)]
        case .every:
            guard let ms = Self.parseDurationMs(self.everyText) else {
                throw NSError(
                    domain: "Cron",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid every duration (use 10m, 1h, 1d)."])
            }
            schedule = ["kind": "every", "everyMs": ms]
        case .cron:
            let expr = self.cronExpr.trimmingCharacters(in: .whitespacesAndNewlines)
            if expr.isEmpty {
                throw NSError(
                    domain: "Cron",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "Cron expression is required."])
            }
            let tz = self.cronTz.trimmingCharacters(in: .whitespacesAndNewlines)
            if tz.isEmpty {
                schedule = ["kind": "cron", "expr": expr]
            } else {
                schedule = ["kind": "cron", "expr": expr, "tz": tz]
            }
        }

        let payload: [String: Any] = {
            if self.sessionTarget == .isolated { return self.buildAgentTurnPayload() }
            switch self.payloadKind {
            case .systemEvent:
                let text = self.systemEventText.trimmingCharacters(in: .whitespacesAndNewlines)
                return ["kind": "systemEvent", "text": text]
            case .agentTurn:
                return self.buildAgentTurnPayload()
            }
        }()

        if self.sessionTarget == .main, payload["kind"] as? String == "agentTurn" {
            throw NSError(
                domain: "Cron",
                code: 0,
                userInfo: [
                    NSLocalizedDescriptionKey: "Main session jobs require systemEvent payloads (switch Session target to isolated).",
                ])
        }

        if self.sessionTarget == .isolated, payload["kind"] as? String == "systemEvent" {
            throw NSError(
                domain: "Cron",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "Isolated jobs require agentTurn payloads."])
        }

        if payload["kind"] as? String == "systemEvent" {
            if (payload["text"] as? String ?? "").isEmpty {
                throw NSError(
                    domain: "Cron",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "System event text is required."])
            }
        } else if payload["kind"] as? String == "agentTurn" {
            if (payload["message"] as? String ?? "").isEmpty {
                throw NSError(
                    domain: "Cron",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "Agent message is required."])
            }
        }

        var root: [String: Any] = [
            "enabled": self.enabled,
            "schedule": schedule,
            "sessionTarget": self.sessionTarget.rawValue,
            "wakeMode": self.wakeMode.rawValue,
            "payload": payload,
        ]
        if !name.isEmpty { root["name"] = name }

        if self.sessionTarget == .isolated {
            let trimmed = self.postPrefix.trimmingCharacters(in: .whitespacesAndNewlines)
            root["isolation"] = [
                "postToMainPrefix": trimmed.isEmpty ? "Cron" : trimmed,
            ]
        }

        return root
    }

    private func buildAgentTurnPayload() -> [String: Any] {
        let msg = self.agentMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        var payload: [String: Any] = ["kind": "agentTurn", "message": msg]
        let thinking = self.thinking.trimmingCharacters(in: .whitespacesAndNewlines)
        if !thinking.isEmpty { payload["thinking"] = thinking }
        if let n = Int(self.timeoutSeconds), n > 0 { payload["timeoutSeconds"] = n }
        payload["deliver"] = self.deliver
        if self.deliver {
            payload["channel"] = self.channel
            let to = self.to.trimmingCharacters(in: .whitespacesAndNewlines)
            if !to.isEmpty { payload["to"] = to }
            payload["bestEffortDeliver"] = self.bestEffortDeliver
        }
        return payload
    }

    private static func parseDurationMs(_ input: String) -> Int? {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return nil }

        let rx = try? NSRegularExpression(pattern: #"^(\d+(?:\.\d+)?)(ms|s|m|h|d)$"#, options: [.caseInsensitive])
        guard let match = rx?.firstMatch(in: raw, range: NSRange(location: 0, length: raw.utf16.count)) else {
            return nil
        }
        func group(_ idx: Int) -> String {
            let range = match.range(at: idx)
            guard let r = Range(range, in: raw) else { return "" }
            return String(raw[r])
        }
        let n = Double(group(1)) ?? 0
        if !n.isFinite || n <= 0 { return nil }
        let unit = group(2).lowercased()
        let factor: Double = switch unit {
        case "ms": 1
        case "s": 1000
        case "m": 60000
        case "h": 3_600_000
        default: 86_400_000
        }
        return Int(floor(n * factor))
    }

    private func formatDuration(ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        let s = Double(ms) / 1000.0
        if s < 60 { return "\(Int(round(s)))s" }
        let m = s / 60.0
        if m < 60 { return "\(Int(round(m)))m" }
        let h = m / 60.0
        if h < 48 { return "\(Int(round(h)))h" }
        let d = h / 24.0
        return "\(Int(round(d)))d"
    }
}

#if DEBUG
struct CronSettings_Previews: PreviewProvider {
    static var previews: some View {
        let store = CronJobsStore(isPreview: true)
        store.jobs = [
            CronJob(
                id: "job-1",
                name: "Daily summary",
                enabled: true,
                createdAtMs: 0,
                updatedAtMs: 0,
                schedule: .every(everyMs: 86_400_000, anchorMs: nil),
                sessionTarget: .isolated,
                wakeMode: .now,
                payload: .agentTurn(
                    message: "Summarize inbox",
                    thinking: "low",
                    timeoutSeconds: 600,
                    deliver: true,
                    channel: "last",
                    to: nil,
                    bestEffortDeliver: true),
                isolation: CronIsolation(postToMainPrefix: "Cron"),
                state: CronJobState(
                    nextRunAtMs: Int(Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000),
                    runningAtMs: nil,
                    lastRunAtMs: nil,
                    lastStatus: nil,
                    lastError: nil,
                    lastDurationMs: nil)),
        ]
        store.selectedJobId = "job-1"
        store.runEntries = [
            CronRunLogEntry(
                ts: Int(Date().timeIntervalSince1970 * 1000),
                jobId: "job-1",
                action: "finished",
                status: "ok",
                error: nil,
                summary: "All good.",
                runAtMs: nil,
                durationMs: 1234,
                nextRunAtMs: nil),
        ]
        return CronSettings(store: store)
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
