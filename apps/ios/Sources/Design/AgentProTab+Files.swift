import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

/// Read-only workspace file browser destinations for the agent surface (#100705).
/// Browsing and preview live in shared OpenClawChatUI; this file binds them to
/// the AgentPro navigation stack and the operator gateway session.
extension AgentProTab {
    var workspaceFilesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Workspace")
            ProCard(radius: AgentLayout.cardRadius) {
                NavigationLink(value: AgentRoute.files(path: "")) {
                    self.agentMenuRow(
                        icon: "folder",
                        title: "Files",
                        detail: "Browse the agent's workspace",
                        value: "",
                        color: self.gatewayConnected ? OpenClawBrand.accent : .secondary,
                        showsChevron: true)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    func filesDestination(path: String) -> some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                ProCard(radius: AgentLayout.cardRadius) {
                    WorkspaceDirectoryView(
                        agentId: self.activeAgentID,
                        path: path,
                        requester: self.workspaceRequester,
                        onOpen: { entry in
                            let isDirectory = (entry.kind.value as? String) == "directory"
                            self.navigationPath.append(
                                isDirectory
                                    ? AgentRoute.files(path: entry.path)
                                    : AgentRoute.filePreview(path: entry.path))
                        })
                }
                .padding(.horizontal, OpenClawProMetric.pagePadding)
                .padding(.vertical, 18)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle(path.isEmpty ? "Files" : (path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
    }

    func filePreviewDestination(path: String) -> some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                WorkspaceFilePreviewView(
                    agentId: self.activeAgentID,
                    path: path,
                    requester: self.workspaceRequester)
                    .padding(.horizontal, OpenClawProMetric.pagePadding)
                    .padding(.vertical, 18)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var workspaceRequester: WorkspaceGatewayRequester {
        let session = self.appModel.operatorSession
        return { method, paramsJSON in
            try await session.request(method: method, paramsJSON: paramsJSON, timeoutSeconds: 15)
        }
    }
}
