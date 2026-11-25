import SwiftUI
import UIKit
import UserNotifications

struct NativeNotificationSettingsRow: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(NotificationServingPreference.storageKey)
    private var servingEnabled = NotificationServingPreference.defaultEnabled
    @State private var authorization: UNAuthorizationStatus?
    @State private var isVisible = false
    @State private var actionTask: Task<Void, Never>?
    @State private var resumesActivation = false
    @State private var errorText: String?
    @State private var consent = IOSDeviceSettingsConsentPresenter()
    @State private var consentAnchor = UIView(frame: .zero)
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var enrollmentEnabled: Bool {
        self.servingEnabled &&
            (!PushBuildConfig.current.usesOpenClawHostedRelay || PushEnrollmentConsent.disclosureAccepted)
    }

    private var registrationComplete: Bool {
        guard let authorization else { return false }
        return SettingsNotificationStatus(authorization).allowsNotifications &&
            self.enrollmentEnabled && self.appModel.hasSubmittedNotificationRegistration
    }

    private var hasSystemDestination: Bool {
        self.authorization == .denied || self.registrationComplete
    }

    private var actionTitle: LocalizedStringKey {
        if self.hasSystemDestination { return "iOS Settings" }
        guard let authorization,
              SettingsNotificationStatus(authorization).allowsNotifications,
              self.enrollmentEnabled
        else { return "Set up" }
        return "Retry"
    }

    private var statusText: String? {
        if let errorText { return errorText }
        guard let authorization else { return nil }
        if authorization == .denied { return String(localized: "Off in iOS") }
        guard SettingsNotificationStatus(authorization).allowsNotifications, self.enrollmentEnabled else {
            return nil
        }
        if !self.appModel.gatewayConnected { return String(localized: "Waiting for Gateway") }
        if !self.appModel.hasAPNsDeviceToken { return String(localized: "Waiting for Apple") }
        return nil
    }

    private var rowLabel: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("Notifications").font(SettingsType.label)
                if let statusText = self.statusText {
                    Text(verbatim: statusText)
                        .font(SettingsType.description)
                        .foregroundStyle(SettingsInk.secondary)
                }
            }
        } icon: {
            NativeSettingsRowIcon(systemName: "bell")
        }
    }

    @ViewBuilder private var rowTrailing: some View {
        if self.actionTask != nil {
            ProgressView().controlSize(.small)
        } else {
            // Same value style as every other row; the arrow says the row leaves the app.
            HStack(spacing: 6) {
                SettingsValueText(.localized(self.actionTitle))
                Image(systemName: self.hasSystemDestination ? "arrow.up.right" : "chevron.right")
                    .font(OpenClawType.footnoteSemiBold)
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
        }
    }

    var body: some View {
        Button {
            if self.registrationComplete {
                self.openSystemSettings()
            } else {
                self.activate(openSettingsIfDenied: true)
            }
        } label: {
            Group {
                // Accessibility sizes stack the value under the label, like the system rows,
                // instead of breaking the label mid-word beside it.
                if self.dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 4) {
                        self.rowLabel
                        self.rowTrailing
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    HStack(spacing: 10) {
                        self.rowLabel
                        Spacer(minLength: 0)
                        self.rowTrailing
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(self.actionTask != nil)
        .accessibilityIdentifier("NativeSettings.Notifications")
        .background(NativeNotificationConsentAnchor(view: self.consentAnchor))
        .onAppear { self.isVisible = true }
        .onDisappear {
            self.isVisible = false
            self.actionTask?.cancel()
            self.actionTask = nil
            self.consent.cancel()
        }
        .task { await self.refreshAuthorization() }
        .onChange(of: self.scenePhase) { _, phase in
            guard phase == .active else { return }
            if self.resumesActivation {
                self.resumesActivation = false
                self.activate(openSettingsIfDenied: false)
            } else {
                Task { await self.refreshAuthorization() }
            }
        }
    }

    private func refreshAuthorization() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        guard !Task.isCancelled, self.isVisible else { return }
        self.authorization = status
    }

    private func activate(openSettingsIfDenied: Bool) {
        guard self.actionTask == nil else { return }
        self.errorText = nil
        self.actionTask = Task { @MainActor in
            defer { self.actionTask = nil }
            await self.refreshAuthorization()
            guard !Task.isCancelled, self.isVisible else { return }
            if self.authorization == .denied, openSettingsIfDenied {
                self.resumesActivation = true
                let opened = await IOSDeviceSettingsActions.openNotificationSettings()
                if !opened {
                    self.resumesActivation = false
                    self.errorText = String(localized: "Could not open iOS settings")
                }
                return
            }
            let status = await IOSDeviceSettingsActions.activateNativeNotifications(
                confirmDisclosure: {
                    await self.consent.confirm(.notificationEnrollment, from: self.consentAnchor)
                },
                isCurrent: { !Task.isCancelled && self.isVisible })
            guard !Task.isCancelled, self.isVisible else { return }
            if let status {
                self.authorization = status
            } else {
                await self.refreshAuthorization()
            }
            if let authorization = self.authorization,
               SettingsNotificationStatus(authorization).allowsNotifications,
               self.enrollmentEnabled
            {
                await self.appModel
                    .retryNotificationRegistration(shouldContinue: { !Task.isCancelled && self.isVisible })
            }
        }
    }

    private func openSystemSettings() {
        self.errorText = nil
        self.actionTask = Task { @MainActor in
            defer { self.actionTask = nil }
            if await !(IOSDeviceSettingsActions.openNotificationSettings()) {
                self.errorText = String(localized: "Could not open iOS settings")
            }
        }
    }
}

private struct NativeNotificationConsentAnchor: UIViewRepresentable {
    let view: UIView

    func makeUIView(context _: Context) -> UIView {
        self.view
    }

    func updateUIView(_: UIView, context _: Context) {}
}
