import OpenClawKit
import SwiftUI

// MARK: - HealthExportSettingsView

/// Settings screen to (a) grant HealthKit read access, (b) paste the webhook token + URL once,
/// and (c) export manually. The webhook URL is validated to https + `.ts.net` before it can be
/// saved (anti-exfiltration). Token/URL go to the Keychain; nothing sensitive is shown back.
struct HealthExportSettingsView: View {
    @State private var service = HealthExportService.shared
    @Environment(\.scenePhase) private var scenePhase

    @State private var tokenInput: String = ""
    @State private var urlInput: String = ""
    @State private var saveError: String?
    @State private var didLoadExistingURL = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.statusCard
            self.authorizationCard
            self.webhookCard
            self.exportActionsCard
            self.infoCard
        }
        .onAppear {
            self.loadExistingURLIfNeeded()
        }
        .onChange(of: self.scenePhase) { _, phase in
            if phase == .active {
                self.service.isAuthorizedRefresh()
            }
        }
    }

    // MARK: Status

    private var statusCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            HStack(spacing: 12) {
                ProIconBadge(systemName: "heart.text.square", color: self.statusColor)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Health Export")
                        .font(.subheadline.weight(.semibold))
                    Text(self.statusDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                Spacer(minLength: 8)
                Text(self.statusValue)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(self.statusColor)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    // MARK: Authorization

    private var authorizationCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Apple Health Access")
                    .font(.subheadline.weight(.semibold))
                Text("OpenClaw reads steps, heart rate, HRV, energy, distance, sleep, and workouts "
                    + "(read-only) so it can forward them to your own webhook.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    Task { await self.service.requestAuthorization() }
                } label: {
                    Label(
                        self.service.isAuthorized ? "Health Access Requested" : "Grant Health Access",
                        systemImage: self.service.isAuthorized ? "checkmark.seal" : "heart")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(!self.service.isHealthAvailable)

                if !self.service.isHealthAvailable {
                    Text("Health data is not available on this device.")
                        .font(.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    // MARK: Webhook config

    private var webhookCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Webhook")
                    .font(.subheadline.weight(.semibold))
                Text("Must be an https URL on your tailnet (ends in .ts.net).")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                TextField("https://your-host.tailnet.ts.net:8446/health/ingest", text: self.$urlInput)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .textFieldStyle(.roundedBorder)

                SecureField("Bearer token", text: self.$tokenInput)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)

                HStack(spacing: 10) {
                    Button {
                        self.saveConfiguration()
                    } label: {
                        Label("Save", systemImage: "tray.and.arrow.down")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(self.tokenInput.isEmpty || self.urlInput.isEmpty)

                    if self.service.isConfigured {
                        Button(role: .destructive) {
                            self.clearConfiguration()
                        } label: {
                            Label("Clear", systemImage: "trash")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                }

                if let saveError {
                    Text(saveError)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(OpenClawBrand.danger)
                }
                if self.service.isConfigured, self.saveError == nil {
                    Text("Webhook saved. Token is stored securely and never shown.")
                        .font(.caption2)
                        .foregroundStyle(OpenClawBrand.ok)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    // MARK: Export actions

    private var exportActionsCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    Task { await self.service.exportNow() }
                } label: {
                    Label("Export Now", systemImage: "arrow.up.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(!self.service.isConfigured || self.isExporting)

                Text("Exports also run automatically when new data arrives and when the app opens.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    // MARK: Info

    private var infoCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 8) {
                self.infoRow(icon: "lock.shield", text: "Read-only: OpenClaw never writes to Apple Health.")
                self.infoRow(icon: "location.slash", text: "Workout GPS routes are never read or sent.")
                self.infoRow(icon: "network", text: "Data only leaves to your https .ts.net webhook.")
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func infoRow(icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(OpenClawBrand.accent)
                .frame(width: 18)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
    }

    // MARK: Derived state

    private var isExporting: Bool {
        if case .exporting = self.service.status { return true }
        return false
    }

    private var statusValue: String {
        switch self.service.status {
        case .idle: "Ready"
        case .exporting: "Exporting"
        case .success: "Sent"
        case .nothingNew: "Up to date"
        case .needsAttention: "Action needed"
        case .retrying: "Retrying"
        case .notConfigured: "Setup"
        case .notAuthorized: "No access"
        }
    }

    private var statusDetail: String {
        switch self.service.status {
        case .idle:
            "Ready to export when new data arrives."
        case .exporting:
            "Reading and uploading health data..."
        case let .success(uploaded, at):
            "Sent \(uploaded) item(s) at \(Self.timeText(at))."
        case let .nothingNew(at):
            "No new data to send (checked \(Self.timeText(at)))."
        case let .needsAttention(message):
            message
        case let .retrying(nextAttempt, message):
            if let nextAttempt {
                "\(message) Next try \(Self.timeText(nextAttempt))."
            } else {
                message
            }
        case .notConfigured:
            "Add your webhook URL and token to start."
        case .notAuthorized:
            "Grant Apple Health access to enable export."
        }
    }

    private var statusColor: Color {
        switch self.service.status {
        case .success, .nothingNew, .idle: OpenClawBrand.ok
        case .exporting, .retrying: OpenClawBrand.accent
        case .needsAttention, .notAuthorized: OpenClawBrand.warn
        case .notConfigured: .secondary
        }
    }

    // MARK: Actions

    private func saveConfiguration() {
        self.saveError = nil
        let saved = self.service.saveConfiguration(token: self.tokenInput, urlString: self.urlInput)
        if saved {
            self.tokenInput = ""
            // Re-arm observers now that we have a destination.
            HealthExportBackgroundTask.startObserving()
            HealthExportBackgroundTask.schedule()
        } else {
            self.saveError = "Could not save. The URL must be https and end in .ts.net, "
                + "and the token cannot be empty."
        }
    }

    private func clearConfiguration() {
        self.service.clearConfiguration()
        HealthExportBackgroundTask.stopObserving()
        self.urlInput = ""
        self.tokenInput = ""
        self.saveError = nil
    }

    private func loadExistingURLIfNeeded() {
        guard !self.didLoadExistingURL else { return }
        self.didLoadExistingURL = true
        if let existing = HealthExportConfigStore.displayURL() {
            self.urlInput = existing
        }
    }

    private static func timeText(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }
}
