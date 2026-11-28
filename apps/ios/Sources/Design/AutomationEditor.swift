import OpenClawKit
import SwiftUI

struct AutomationEditor: View {
    let gateway: AutomationGateway
    let job: AutomationGateway.Definition?
    let agentID: String?
    let saved: (AutomationGateway.Definition) -> Void
    let original: AutomationFormDraft
    @State private var draft: AutomationFormDraft
    @State private var expanded: Component?
    @State private var saving = false
    @State private var discard = false
    @State private var errorText: String?
    @Environment(\.dismiss) private var dismiss
    private enum Component { case date, time }

    init(
        gateway: AutomationGateway,
        job: AutomationGateway.Definition? = nil,
        agentID: String?,
        saved: @escaping (AutomationGateway.Definition) -> Void)
    {
        self.gateway = gateway
        self.job = job
        self.agentID = agentID
        self.saved = saved
        let initial = AutomationFormDraft(job: job)
        self.original = initial
        self._draft = State(initialValue: initial)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(text: self.$draft.name, prompt: Text("Name").font(OpenClawType.headline)) {
                        Text("Name").font(OpenClawType.headline)
                    }
                    .font(OpenClawType.headline).accessibilityIdentifier("automation.name")
                    if self.job == nil || self.job?.instructionsKey != nil {
                        TextField(
                            text: self.$draft.instructions,
                            prompt: Text("What should the agent do?").font(OpenClawType.body),
                            axis: .vertical)
                        {
                            Text("Instructions").font(OpenClawType.body)
                        }.font(OpenClawType.body).lineLimit(2...8)
                            .accessibilityIdentifier("automation.instructions")
                    }
                }
                Section {
                    Picker(selection: self.$draft.frequency) {
                        ForEach(
                            AutomationFormDraft.Frequency.allCases
                                .filter { $0 != .existing || self.original.frequency == .existing },
                            id: \.self)
                        { value in
                            Text(verbatim: value.title).font(OpenClawType.body).tag(value)
                        }
                    } label: { Text("Repeat").font(OpenClawType.body) }
                    if self.draft.frequency == .weekly {
                        Picker(selection: self.$draft.weekday) {
                            ForEach(0..<7, id: \.self) { day in
                                Text(verbatim: Calendar.current.weekdaySymbols[day]).font(OpenClawType.body).tag(day)
                            }
                        } label: { Text("Day").font(OpenClawType.body) }
                    }
                    if self.draft.frequency != .existing {
                        HStack {
                            Text(self.draft.frequency == .once ? "Run at" : "Time").font(OpenClawType.body)
                            Spacer()
                            if self.draft.frequency == .once { self.pill(.date) }
                            self.pill(.time)
                        }
                        if let expanded = self.expanded {
                            if expanded == .date, self.draft.frequency == .once {
                                DatePicker(selection: self.$draft.date, in: Date.now..., displayedComponents: .date) {
                                    Text("Date").font(OpenClawType.body)
                                }
                                .datePickerStyle(.graphical).labelsHidden()
                            } else if expanded == .time {
                                let minimum: Date = self.draft.frequency == .once ? .now : .distantPast
                                DatePicker(
                                    selection: self.$draft.date,
                                    in: minimum...,
                                    displayedComponents: .hourAndMinute)
                                {
                                    Text("Time").font(OpenClawType.body)
                                }
                                .datePickerStyle(.wheel).labelsHidden().frame(maxWidth: .infinity)
                            }
                        }
                    } else if let job {
                        Text(verbatim: job.scheduleLabel).font(OpenClawType.body).foregroundStyle(.secondary)
                    }
                } header: { Text("Schedule").font(OpenClawType.footnote) }
                    footer: {
                        if self.draft.frequency == .once, self.draft.date <= .now,
                           self.job == nil || self.draft.frequency != self.original.frequency || self.draft.date != self
                               .original.date
                        {
                            Text("Choose a future date and time.").font(OpenClawType.footnote)
                        } else if self.draft.frequency != .existing,
                                  self.draft.zone.identifier != TimeZone.current.identifier
                        {
                            let zone = self.draft.zone.localizedName(for: .generic, locale: .current) ?? self.draft.zone
                                .identifier
                            Text(verbatim: String(format: String(localized: "Time zone: %@"), zone))
                                .font(OpenClawType.footnote)
                        }
                    }
                Section {
                    Picker(selection: self.$draft.target) {
                        Text("Separate chat").font(OpenClawType.body).tag("isolated")
                        Text("Main chat").font(OpenClawType.body).tag("main")
                        if !["isolated", "main"]
                            .contains(self.original.target)
                        {
                            Text(self.original.target == "current" ? "Current chat" : "Existing chat")
                                .font(OpenClawType.body).tag(self.original.target)
                        }
                    } label: { Text("Run in").font(OpenClawType.body) }
                        .disabled(self.job != nil && self.job?.payload["kind"]?.stringValue != "agentTurn" || self.job?
                            .payloadSource != nil)
                }
                if let errorText {
                    Text(verbatim: errorText).font(OpenClawType.footnote).foregroundStyle(OpenClawBrand.danger)
                }
            }
            .disabled(self.saving).environment(\.timeZone, self.draft.zone)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: self.draft.frequency) { self.expanded = nil }
            .navigationTitle(self.job == nil ? "New automation" : "Edit automation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { if self.draft == self.original { self.dismiss() } else { self.discard = true } } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel(Text("Cancel")).disabled(self.saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await self.save() } } label: {
                        if self.saving {
                            ProgressView()
                        } else {
                            Text(self.job == nil ? "Create" : "Save").font(OpenClawType.headline)
                        }
                    }.buttonStyle(.borderedProminent).accessibilityIdentifier("automation.save")
                        .disabled(self
                            .saving || (self.job != nil && self.original == self.draft) || (try? self.draft.parameters(
                                job: self.job,
                                original: self.original,
                                agentID: self.agentID)) == nil)
                }
            }
            .interactiveDismissDisabled(self.saving || self.original != self.draft)
            .alert("Discard changes?", isPresented: self.$discard) {
                Button(role: .cancel) {} label: { Text("Keep editing").font(OpenClawType.body) }
                Button(role: .destructive) { self.dismiss() } label: { Text("Discard").font(OpenClawType.body) }
            }
        }
    }

    private func pill(_ component: Component) -> some View {
        var format = Date.FormatStyle(
            date: component == .date ? .abbreviated : .omitted,
            time: component == .time ? .shortened : .omitted)
        format.timeZone = self.draft.zone
        return Button { withAnimation { self.expanded = self.expanded == component ? nil : component } } label: {
            Text(self.draft.date, format: format).font(OpenClawType.subheadMedium)
                .foregroundStyle(self.expanded == component ? OpenClawBrand.accent : Color.primary)
                .padding(.horizontal, 9).padding(.vertical, 5).background(.quaternary, in: Capsule())
        }.buttonStyle(.borderless).accessibilityIdentifier(component == .time ? "automation.time" : "automation.date")
    }

    private func save() async {
        guard !self.saving else { return }
        self.saving = true
        defer { self.saving = false }
        do {
            let params = try self.draft.parameters(job: self.job, original: self.original, agentID: self.agentID)
            let result = try await self.gateway.read(
                AutomationGateway.Definition.self,
                self.job == nil ? "cron.add" : "cron.update",
                params)
            self.saved(result)
            self.dismiss()
        } catch { self.errorText = error.localizedDescription }
    }
}

extension AutomationGateway.Definition {
    var scheduleLabel: String {
        let s = self.schedule
        let row = ChatInfoAutomation(
            id: self.id,
            name: self.name,
            enabled: self.enabled,
            schedule: .init(
                kind: s["kind"]?.stringValue ?? "",
                expr: s["expr"]?.stringValue,
                at: s["at"]?.stringValue,
                everyMs: s["everyMs"]?.intValue))
        let label = row.timing(ChatInfoAutomationSchedule()) ?? String(localized: "Custom schedule")
        if let zone = s["tz"]?.stringValue, zone != TimeZone.current.identifier { return "\(label) · \(zone)" }
        return label
    }
}
