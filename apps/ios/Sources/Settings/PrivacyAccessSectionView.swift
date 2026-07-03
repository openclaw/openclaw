import Contacts
import EventKit
import Photos
import SwiftUI
import UIKit

struct PrivacyAccessSectionView: View {
    @Environment(GatewayConnectionController.self) private var gatewayController
    @State private var contactsStatus: CNAuthorizationStatus = CNContactStore.authorizationStatus(for: .contacts)
    @State private var calendarStatus: EKAuthorizationStatus = EKEventStore.authorizationStatus(for: .event)
    @State private var remindersStatus: EKAuthorizationStatus = EKEventStore.authorizationStatus(for: .reminder)
    @State private var photosStatus = PhotoLibraryAccess.authorizationStatus()

    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        DisclosureGroup("Privacy & Access") {
            self.permissionRow(
                title: "Contacts",
                icon: "person.crop.circle",
                status: self.statusText(for: self.contactsStatus),
                detail: "Search and add contacts from the assistant.",
                actionTitle: self.actionTitle(for: self.contactsStatus),
                action: self.handleContactsAction)

            self.permissionRow(
                title: "Photos",
                icon: "photo.on.rectangle",
                status: self.photosStatusText,
                detail: self.photosDetail,
                actionTitle: self.photosActionTitle,
                action: self.handlePhotosAction)

            self.permissionRow(
                title: "Calendar (Add Events)",
                icon: "calendar.badge.plus",
                status: self.calendarWriteStatusText,
                detail: "Add events with least privilege.",
                actionTitle: self.calendarWriteActionTitle,
                action: self.handleCalendarWriteAction)

            self.permissionRow(
                title: "Calendar (View Events)",
                icon: "calendar",
                status: self.calendarReadStatusText,
                detail: "List and read calendar events.",
                actionTitle: self.calendarReadActionTitle,
                action: self.handleCalendarReadAction)

            self.permissionRow(
                title: "Reminders",
                icon: "checklist",
                status: self.remindersStatusText,
                detail: "List, add, and complete reminders.",
                actionTitle: self.remindersActionTitle,
                action: self.handleRemindersAction)
        }
        .onAppear { self.refreshAll() }
        .onChange(of: self.scenePhase) { _, phase in
            if phase == .active {
                self.refreshAll()
            }
        }
    }

    private func permissionRow(
        title: String,
        icon: String,
        status: String,
        detail: String,
        actionTitle: String?,
        action: (() -> Void)?) -> some View
    {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(title, systemImage: icon)
                Spacer()
                Text(status)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(self.statusColor(for: status))
                    .accessibilityIdentifier("privacy-access-\(title)-status")
            }
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.footnote)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("privacy-access-\(title)-action")
            }
        }
        .padding(.vertical, 2)
    }

    private func statusColor(for status: String) -> Color {
        switch status {
        case "Allowed", "Limited":
            OpenClawBrand.ok
        case "Not Set":
            OpenClawBrand.warn
        case "Add-Only":
            OpenClawBrand.warn
        default:
            OpenClawBrand.danger
        }
    }

    private func statusText(for cnStatus: CNAuthorizationStatus) -> String {
        switch cnStatus {
        case .authorized, .limited:
            "Allowed"
        case .notDetermined:
            "Not Set"
        case .denied, .restricted:
            "Not Allowed"
        @unknown default:
            "Unknown"
        }
    }

    private func actionTitle(for cnStatus: CNAuthorizationStatus) -> String? {
        switch cnStatus {
        case .notDetermined:
            "Request Access"
        case .denied, .restricted:
            "Open Settings"
        default:
            nil
        }
    }

    private var photosStatusText: String {
        switch self.photosStatus {
        case .authorized:
            "Allowed"
        case .limited:
            "Limited"
        case .notDetermined:
            "Not Set"
        case .denied, .restricted:
            "Not Allowed"
        @unknown default:
            "Unknown"
        }
    }

    private var photosDetail: String {
        self.photosStatus == .limited
            ? "Read photos you select for the assistant."
            : "Read recent photos for the assistant."
    }

    private var photosActionTitle: String? {
        switch self.photosStatus {
        case .notDetermined:
            "Request Access"
        case .limited:
            "Manage Access"
        case .denied, .restricted:
            "Open Settings"
        default:
            nil
        }
    }

    private func handlePhotosAction() {
        switch self.photosStatus {
        case .notDetermined:
            Task {
                let status = await PhotoLibraryAccess.requestReadWrite()
                await MainActor.run { self.updatePhotosStatus(status) }
            }
        case .limited, .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private func handleContactsAction() {
        switch self.contactsStatus {
        case .notDetermined:
            Task {
                let granted = await PermissionRequestBridge.awaitRequest { completion in
                    let store = CNContactStore()
                    store.requestAccess(for: .contacts) { granted, _ in
                        completion(granted)
                    }
                }
                await MainActor.run {
                    self.refreshAll()
                    if granted {
                        self.contactsStatus = .authorized
                    }
                }
            }
        case .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private var calendarWriteStatusText: String {
        switch self.calendarStatus {
        case .authorized, .fullAccess, .writeOnly:
            "Allowed"
        case .notDetermined:
            "Not Set"
        case .denied, .restricted:
            "Not Allowed"
        @unknown default:
            "Unknown"
        }
    }

    private var calendarWriteActionTitle: String? {
        switch self.calendarStatus {
        case .notDetermined:
            "Request Access"
        case .denied, .restricted:
            "Open Settings"
        default:
            nil
        }
    }

    private func handleCalendarWriteAction() {
        switch self.calendarStatus {
        case .notDetermined:
            Task {
                let granted = await self.requestCalendarWriteOnly()
                await MainActor.run {
                    self.refreshAll()
                    if granted {
                        self.calendarStatus = .writeOnly
                    }
                }
            }
        case .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private var calendarReadStatusText: String {
        switch self.calendarStatus {
        case .authorized, .fullAccess:
            "Allowed"
        case .writeOnly:
            "Add-Only"
        case .notDetermined:
            "Not Set"
        case .denied, .restricted:
            "Not Allowed"
        @unknown default:
            "Unknown"
        }
    }

    private var calendarReadActionTitle: String? {
        switch self.calendarStatus {
        case .notDetermined:
            "Request Full Access"
        case .writeOnly:
            "Upgrade to Full Access"
        case .denied, .restricted:
            "Open Settings"
        default:
            nil
        }
    }

    private func handleCalendarReadAction() {
        switch self.calendarStatus {
        case .notDetermined, .writeOnly:
            Task {
                let granted = await self.requestCalendarFull()
                await MainActor.run {
                    self.refreshAll()
                    if granted {
                        self.calendarStatus = .fullAccess
                    }
                }
            }
        case .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private var remindersStatusText: String {
        switch self.remindersStatus {
        case .authorized, .fullAccess:
            "Allowed"
        case .writeOnly:
            "Add-Only"
        case .notDetermined:
            "Not Set"
        case .denied, .restricted:
            "Not Allowed"
        @unknown default:
            "Unknown"
        }
    }

    private var remindersActionTitle: String? {
        switch self.remindersStatus {
        case .notDetermined:
            "Request Access"
        case .writeOnly:
            "Upgrade to Full Access"
        case .denied, .restricted:
            "Open Settings"
        default:
            nil
        }
    }

    private func handleRemindersAction() {
        switch self.remindersStatus {
        case .notDetermined, .writeOnly:
            Task {
                let granted = await self.requestRemindersFull()
                await MainActor.run {
                    self.refreshAll()
                    if granted {
                        self.remindersStatus = .fullAccess
                    }
                }
            }
        case .denied, .restricted:
            self.openSettings()
        default:
            break
        }
    }

    private func refreshAll() {
        self.contactsStatus = CNContactStore.authorizationStatus(for: .contacts)
        self.calendarStatus = EKEventStore.authorizationStatus(for: .event)
        self.remindersStatus = EKEventStore.authorizationStatus(for: .reminder)
        self.updatePhotosStatus(PhotoLibraryAccess.authorizationStatus())
    }

    private func updatePhotosStatus(_ status: PHAuthorizationStatus) {
        let changed = self.photosStatus != status
        self.photosStatus = status
        if changed {
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
        }
    }

    private func requestCalendarWriteOnly() async -> Bool {
        await PermissionRequestBridge.awaitRequest { completion in
            let store = EKEventStore()
            store.requestWriteOnlyAccessToEvents { granted, _ in
                completion(granted)
            }
        }
    }

    private func requestCalendarFull() async -> Bool {
        await PermissionRequestBridge.awaitRequest { completion in
            let store = EKEventStore()
            store.requestFullAccessToEvents { granted, _ in
                completion(granted)
            }
        }
    }

    private func requestRemindersFull() async -> Bool {
        await PermissionRequestBridge.awaitRequest { completion in
            let store = EKEventStore()
            store.requestFullAccessToReminders { granted, _ in
                completion(granted)
            }
        }
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}
