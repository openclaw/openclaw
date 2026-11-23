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

    var body: some View {
        Button {
            if self.registrationComplete {
                self.openSystemSettings()
            } else {
                self.activate(openSettingsIfDenied: true)
            }
        } label: {
            HStack(spacing: 10) {
                Label {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Notifications").font(OpenClawType.body)
                        if let statusText = self.statusText {
                            Text(verbatim: statusText)
                                .font(OpenClawType.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                } icon: {
                    NativeSettingsRowIcon(systemName: "bell")
                }
                Spacer(minLength: 0)
                if self.actionTask != nil {
                    ProgressView().controlSize(.small)
                } else {
                    HStack(spacing: 5) {
                        Text(self.actionTitle)
                            .font(OpenClawType.subhead)
                        Image(systemName: self.hasSystemDestination ? "arrow.up.right" : "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .accessibilityHidden(true)
                    }
                    .foregroundStyle(.secondary)
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
