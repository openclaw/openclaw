import OpenClawKit
import SwiftUI
import UIKit
import UserNotifications

/// A local projection of the same device owner used by the Dashboard, never a Gateway editor.
struct LocalDeviceSettingsScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(AppAppearanceModel.self) private var appearanceModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.scenePhase) private var scenePhase
    @State private var notificationStatus: UNAuthorizationStatus?
    @State private var locationServicesEnabled: Bool?
    @State private var refreshID = UUID()
    @State private var isVisible = false
    @State private var actionTask: Task<Void, Never>?
    @State private var errorText: String?
    @State private var consent = IOSDeviceSettingsConsentPresenter()
    @State private var consentAnchor = UIView(frame: .zero)
    @State private var permissions = IOSDeviceSettingsPermissions()

    private var snapshot: DeviceSettingsSnapshot {
        IOSDeviceSettingsSnapshotProducer(appModel: self.appModel, appearanceModel: self.appearanceModel)
            .snapshot(
                notificationStatus: self.notificationStatus,
                locationServicesEnabled: self.locationServicesEnabled)
    }

    var body: some View {
        let snapshot = self.snapshot
        List {
            self.appearanceSection(snapshot)
            self.deviceSection(snapshot)
            self.voiceSection(snapshot)
            self.permissionsSection(snapshot)
            if let errorText {
                Text(errorText)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("LocalDeviceSettings.Error")
            }
        }
        .accessibilityIdentifier("LocalDeviceSettings")
        .background(LocalDeviceSettingsConsentAnchor(view: self.consentAnchor))
        .disabled(self.actionTask != nil)
        .onAppear { self.isVisible = true }
        .onDisappear {
            self.isVisible = false
            self.actionTask?.cancel()
            self.consent.cancel()
        }
        .onChange(of: self.scenePhase) { _, phase in
            if phase == .active { self.refreshID = UUID() }
        }
        .onReceive(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)) { _ in
            self.refreshID = UUID()
        }
        .task(id: self.refreshID) { await self.refreshPermissions() }
    }

    private func appearanceSection(_ snapshot: DeviceSettingsSnapshot) -> some View {
        Section {
            Picker(selection: Binding(
                get: { snapshot.app?.appearance?.rawValue ?? "system" },
                set: { self.perform(.set(.appearance, .string($0))) }))
            {
                Text("System").font(OpenClawType.body).tag("system")
                Text("Light").font(OpenClawType.body).tag("light")
                Text("Dark").font(OpenClawType.body).tag("dark")
            } label: {
                Text("Appearance").font(OpenClawType.body)
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("LocalDeviceSettings.Appearance")
        } header: {
            Text("Appearance").font(OpenClawType.captionSemiBold)
        } footer: {
            Text("These settings apply only to this device and do not require Gateway admin access.")
                .font(OpenClawType.footnote)
        }
    }

    private func deviceSection(_ snapshot: DeviceSettingsSnapshot) -> some View {
        Section {
            self.toggle("Notifications", key: .notificationsEnabled, value: snapshot.app?.notificationsEnabled)
            self.toggle("Camera access", key: .cameraEnabled, value: snapshot.capabilities?.cameraEnabled)
            self.toggle("Keep screen awake", key: .keepAwakeEnabled, value: snapshot.capabilities?.keepAwakeEnabled)
            if snapshot.capabilities?.healthSummaryAvailable == true {
                self.toggle(
                    "Health summaries",
                    key: .healthSummaryEnabled,
                    value: snapshot.capabilities?.healthSummaryEnabled)
            }
        } header: {
            Text("Device").font(OpenClawType.captionSemiBold)
        }
    }

    private func voiceSection(_ snapshot: DeviceSettingsSnapshot) -> some View {
        Section {
            self.toggle("Voice Wake", key: .wakeEnabled, value: snapshot.voice.wakeEnabled)
            self.toggle("Talk", key: .talkEnabled, value: snapshot.voice.talkEnabled)
            self.toggle("Show Talk control", key: .talkButtonEnabled, value: snapshot.voice.talkButtonEnabled)
            self.toggle(
                "Background listening",
                key: .talkBackgroundEnabled,
                value: snapshot.voice.talkBackgroundEnabled)
            self.toggle("Speakerphone", key: .speakerphoneEnabled, value: snapshot.voice.speakerphoneEnabled)
        } header: {
            Text("Voice & Talk").font(OpenClawType.captionSemiBold)
        } footer: {
            Text(
                """
                Voice requires a supported device and microphone access. \
                Provider, voice, and speech language remain configured on the Gateway.
                """)
                .font(OpenClawType.footnote)
        }
        .disabled(!snapshot.voice.supported)
    }

    private func permissionsSection(_ snapshot: DeviceSettingsSnapshot) -> some View {
        Section {
            Picker(selection: Binding(
                get: { snapshot.permissions.location.mode.rawValue },
                set: { self.perform(.set(.locationMode, .string($0))) }))
            {
                Text("Off").font(OpenClawType.body).tag("off")
                Text("While using").font(OpenClawType.body).tag("whileUsing")
                Text("Always").font(OpenClawType.body).tag("always")
            } label: {
                Text("Location access").font(OpenClawType.body)
            }
            SettingsDetailRow(
                "Precise Location",
                value: .verbatim(snapshot.permissions.location
                    .precise ? String(localized: "On") : String(localized: "Off")))
            ForEach(snapshot.permissions.entries, id: \.id) { entry in
                HStack {
                    VStack(alignment: .leading) {
                        Text(Self.permissionTitle(entry.id)).font(OpenClawType.body)
                        Text(Self.statusTitle(entry.status))
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if entry.status == .notDetermined || entry.status == .limited {
                        Button {
                            self.perform(.requestPermission(entry.id))
                        } label: {
                            Text("Request").font(OpenClawType.subheadSemiBold)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(String(localized: "Request") + " " + Self.permissionTitle(entry.id))
                    }
                }
            }
            Button {
                self.perform(.openSystemSettings(.location))
            } label: {
                Text("Open iOS Settings").font(OpenClawType.body)
            }
        } header: {
            Text("Permissions").font(OpenClawType.captionSemiBold)
        } footer: {
            Text("iOS controls permission grants and Precise Location. Change denied permissions in iOS Settings.")
                .font(OpenClawType.footnote)
        }
    }

    private func toggle(_ title: LocalizedStringKey, key: DeviceSettingKey, value: Bool?) -> some View {
        Toggle(isOn: Binding(
            get: { value ?? false },
            set: { self.perform(.set(key, .boolean($0))) }))
        {
            Text(title).font(OpenClawType.body)
        }
        .accessibilityIdentifier("LocalDeviceSettings." + key.rawValue)
    }

    private func perform(_ request: DeviceSettingsRequest) {
        guard self.actionTask == nil, self.isVisible, self.scenePhase == .active else { return }
        self.errorText = nil
        self.actionTask = Task { @MainActor in
            defer { self.actionTask = nil }
            let isCurrent: @MainActor @Sendable () -> Bool = {
                self.isVisible && self.scenePhase == .active
            }
            let confirm: @MainActor (IOSDeviceSettingsConsent) async -> Bool = {
                await self.consent.confirm($0, from: self.consentAnchor)
            }
            do {
                let registrationChanged: Bool
                switch request {
                case let .set(key, value):
                    registrationChanged = try await IOSDeviceSettingsActions.set(
                        key,
                        value: value,
                        appModel: self.appModel,
                        appearanceModel: self.appearanceModel,
                        confirm: confirm,
                        isCurrent: isCurrent)
                case let .requestPermission(permission):
                    let changed = try await IOSDeviceSettingsActions.requestPermission(
                        permission,
                        appModel: self.appModel,
                        permissions: self.permissions,
                        confirm: confirm,
                        isCurrent: isCurrent)
                    registrationChanged = changed && !Task.isCancelled && isCurrent()
                case .openSystemSettings:
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    await UIApplication.shared.open(url)
                    registrationChanged = false
                default: return
                }
                // A committed local capability must update registration even if navigation has since changed.
                if registrationChanged {
                    self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
                }
                self.refreshID = UUID()
            } catch is CancellationError {
                // Leaving the native screen retires unfinished permission work.
            } catch {
                self.errorText = String(localized: "Device settings could not be updated. Try again.")
            }
        }
    }

    private func refreshPermissions() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        let servicesEnabled = await LocationService.servicesEnabled()
        guard !Task.isCancelled else { return }
        self.notificationStatus = status
        self.locationServicesEnabled = servicesEnabled
    }

    private static func permissionTitle(_ permission: DeviceSettingsPermission) -> String {
        switch permission {
        case .notifications: String(localized: "Notifications")
        case .camera: String(localized: "Camera")
        case .microphone: String(localized: "Microphone")
        case .speechRecognition: String(localized: "Speech Recognition")
        case .location: String(localized: "Location")
        case .contacts: String(localized: "Contacts")
        case .calendars: String(localized: "Calendars")
        case .reminders: String(localized: "Reminders")
        case .photos: String(localized: "Photos")
        case .accessibility: String(localized: "Accessibility")
        case .screenRecording: String(localized: "Screen Recording")
        case .eventPosting: String(localized: "Event Posting")
        }
    }

    private static func statusTitle(_ status: DeviceSettingsPermissionStatus) -> String {
        switch status {
        case .granted: String(localized: "Allowed")
        case .denied: String(localized: "Denied")
        case .notDetermined: String(localized: "Not requested")
        case .unavailable: String(localized: "Unavailable")
        case .limited: String(localized: "Limited")
        }
    }
}

private struct LocalDeviceSettingsConsentAnchor: UIViewRepresentable {
    let view: UIView

    func makeUIView(context: Context) -> UIView {
        self.view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}
}
