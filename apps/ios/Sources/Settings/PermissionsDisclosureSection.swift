import SwiftUI

struct PermissionsDisclosureSection: View {
    let snapshot: IOSPermissionSnapshot
    let requestingPermission: IOSPermissionKind?
    let onRequest: (IOSPermissionKind) -> Void
    let onOpenSettings: () -> Void
    let onInfo: (IOSPermissionKind) -> Void

    var body: some View {
        DisclosureGroup("Permissions") {
            self.permissionRow(.photos)
            self.permissionRow(.contacts)
            self.permissionRow(.calendar)
            self.permissionRow(.reminders)
            self.permissionRow(.motion)

            Button {
                self.onOpenSettings()
            } label: {
                Label("Open iOS Settings", systemImage: "gear")
            }
        }
    }

    @ViewBuilder
    private func permissionRow(_ kind: IOSPermissionKind) -> some View {
        let state = self.snapshot.state(for: kind)
        HStack(spacing: 8) {
            Text(kind.title)
            Spacer()
            Text(state.label)
                .font(.footnote)
                .foregroundStyle(self.permissionStatusColor(for: state))
            if self.requestingPermission == kind {
                ProgressView()
                    .progressViewStyle(.circular)
            }
            if let action = self.permissionAction(for: state) {
                Button(action.title) {
                    switch action {
                    case .request:
                        self.onRequest(kind)
                    case .openSettings:
                        self.onOpenSettings()
                    }
                }
                .disabled(self.requestingPermission != nil)
            }
            Button {
                self.onInfo(kind)
            } label: {
                Image(systemName: "info.circle")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(kind.title) permission info")
        }
    }

    private enum PermissionAction {
        case request
        case openSettings

        var title: String {
            switch self {
            case .request:
                "Request"
            case .openSettings:
                "Settings"
            }
        }
    }

    private func permissionAction(for state: IOSPermissionState) -> PermissionAction? {
        switch state {
        case .notDetermined, .writeOnly:
            .request
        case .denied, .restricted:
            .openSettings
        case .granted, .limited, .unavailable:
            nil
        }
    }

    private func permissionStatusColor(for state: IOSPermissionState) -> Color {
        switch state {
        case .granted, .limited:
            .green
        case .writeOnly:
            .orange
        case .denied, .restricted:
            .red
        case .notDetermined, .unavailable:
            .secondary
        }
    }
}
