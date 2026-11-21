import Foundation
import OpenClawChatUI
import OpenClawProtocol

@MainActor
enum MacGatewayGroupDefaults {
    static func browser(connection: OpenClawSessionMenuConnection) -> OpenClawGroupDefaultsBrowser {
        // ui/src/components/app-sidebar.ts:93–125: browse the Gateway, including remote hosts,
        // and retain the captured connection's lease for both filesystem operations.
        OpenClawGroupDefaultsBrowser(
            listDirectory: { path in
                try await JSONDecoder().decode(
                    FsListDirResult.self,
                    from: connection.request(OpenClawChatGatewayRequests.groupDefaultsDirectory(path)))
            },
            inspectRepository: { path in
                let result = try await JSONDecoder().decode(
                    WorktreesBranchesResult.self,
                    from: connection.request(OpenClawChatGatewayRequests.groupDefaultsRepository(path)))
                return result.repositorystatus ?? .unavailable
            })
    }
}
