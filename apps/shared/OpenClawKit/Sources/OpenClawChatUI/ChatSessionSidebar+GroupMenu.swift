#if os(macOS)
import AppKit
import SwiftUI

extension ChatSessionSidebar {
    func groupMenu(_ name: String) -> some View {
        Group {
            Button("Rename…") { self.viewModel.promptSidebarGroup(name: name) }
                .disabled(self.menuActions.connection?.allows("sessions.groups.rename") != true)
            Button("New group…") { self.viewModel.promptSidebarGroup() }
                .disabled(self.menuActions.connection?.allows("sessions.groups.put") != true)
            Divider()
            Button("Delete…", role: .destructive) {
                self.viewModel.performSidebarAction {
                    let lease = try await self.viewModel.sessionGroupsRouteLease()
                    let alert = NSAlert()
                    alert.messageText = String(format: String(localized: "Delete group “%@”?"), name)
                    alert.informativeText = String(localized: "Its conversations will remain available.")
                    alert.addButton(withTitle: String(localized: "Delete"))
                    alert.addButton(withTitle: String(localized: "Cancel"))
                    guard alert.runModal() == .alertFirstButtonReturn else { return }
                    self.groups = try await self.viewModel.deleteSessionGroup(name, using: lease)
                }
            }.disabled(self.menuActions.connection?.allows("sessions.groups.delete") != true)
        }
    }
}

extension OpenClawChatViewModel {
    func promptSidebarGroup(name: String? = nil, session: OpenClawChatSessionEntry? = nil) {
        self.performSidebarAction {
            let lease = try await self.sessionGroupsRouteLease()
            let mutation = await self.transport.acquireSessionMutationRouteLease()
            let alert = NSAlert()
            alert.messageText = name == nil ? String(localized: "New group") : String(localized: "Rename group")
            let field = NSTextField(string: name ?? "")
            field.frame.size = NSSize(width: 260, height: 24)
            alert.accessoryView = field
            alert.window.initialFirstResponder = field
            alert.addButton(withTitle: String(localized: "Save"))
            alert.addButton(withTitle: String(localized: "Cancel"))
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return }
            if let name {
                _ = try await self.renameSessionGroup(name, to: value, using: lease)
            } else {
                _ = try await self.createSessionGroup(named: value, using: lease)
            }
            if let session {
                guard let mutation else { throw OpenClawChatTransportSendError.notDispatched }
                try await mutation.patchSession(
                    key: session.key,
                    agentID: session.agentId,
                    expectedSessionID: session.sessionId,
                    label: nil,
                    category: .some(value),
                    pinned: nil,
                    archived: nil,
                    unread: nil)
            }
        }
    }
}

#endif
