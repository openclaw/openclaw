import SwiftUI

private struct NotificationPermissionGuidanceDialogModifier: ViewModifier {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel
    let openNotifications: (String) -> Void
    @State private var suppressFuture = false

    func body(content: Content) -> some View {
        content
            .overlay {
                if let prompt = self.appModel.pendingNotificationPermissionGuidancePrompt {
                    ZStack {
                        Color.black.opacity(0.38)
                            .ignoresSafeArea()

                        NotificationPermissionGuidanceCard(
                            suppressFuture: self.$suppressFuture,
                            onOpenNotifications: {
                                let approvalId = prompt.approvalId
                                self.appModel.dismissNotificationPermissionGuidancePrompt(
                                    suppressFuture: self.suppressFuture)
                                self.suppressFuture = false
                                self.openNotifications(approvalId)
                            },
                            onDismiss: {
                                self.appModel.dismissNotificationPermissionGuidancePrompt(
                                    suppressFuture: self.suppressFuture)
                                self.suppressFuture = false
                            })
                            .padding(.horizontal, 20)
                            .frame(maxWidth: 460)
                            .transition(.scale(scale: 0.98).combined(with: .opacity))
                    }
                    .zIndex(2)
                    .id(prompt.id)
                }
            }
            .animation(
                .easeInOut(duration: 0.18),
                value: self.appModel.pendingNotificationPermissionGuidancePrompt?.id)
            .onChange(of: self.appModel.pendingNotificationPermissionGuidancePrompt?.id) { _, _ in
                self.suppressFuture = false
            }
    }
}

private struct NotificationPermissionGuidanceCard: View {
    @Binding var suppressFuture: Bool
    let onOpenNotifications: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Notifications are off")
                    .font(.headline)
                Text(
                    """
                    Exec approvals can only be reviewed while OpenClaw is open and connected.

                    Enable Notifications to receive approval notifications while OpenClaw is not open.
                    """)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button {
                self.suppressFuture.toggle()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: self.suppressFuture ? "checkmark.square.fill" : "square")
                        .font(.system(size: 20, weight: .semibold))
                    Text("Don't show again")
                        .font(.subheadline)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Don't show again")
            .accessibilityValue(self.suppressFuture ? "On" : "Off")

            VStack(spacing: 10) {
                Button {
                    self.onOpenNotifications()
                } label: {
                    Text("Open Notifications Settings")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                Button(role: .cancel) {
                    self.onDismiss()
                } label: {
                    Text("Not Now")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .controlSize(.large)
            .frame(maxWidth: .infinity)
        }
        .padding(18)
        .proPanelSurface(tint: OpenClawBrand.warn, radius: 20, isProminent: true)
    }
}

extension View {
    func notificationPermissionGuidanceDialog(openNotifications: @escaping (String) -> Void) -> some View {
        self.modifier(NotificationPermissionGuidanceDialogModifier(openNotifications: openNotifications))
    }
}
