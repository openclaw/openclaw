import Foundation
import OpenClawKit

enum ExecApprovalsSQLiteStateStore {
    private static let configKey = "current"

    static func databaseURL() -> URL {
        OpenClawSQLiteStateStore.databaseURL()
    }

    static func storeLocationForDisplay() -> String {
        OpenClawSQLiteStateStore.execApprovalsLocationForDisplay(configKey: self.configKey)
    }

    static func readRawState() -> String? {
        OpenClawSQLiteStateStore.readExecApprovalsRaw(configKey: self.configKey)
    }

    static func writeRawState(_ raw: String) throws {
        let file = self.parse(raw)
        let agents = file.agents.map { Array($0.values) } ?? []
        let allowlistCount = agents.reduce(0) { count, agent in
            count + (agent.allowlist?.count ?? 0)
        }
        try OpenClawSQLiteStateStore.writeExecApprovalsConfig(
            configKey: self.configKey,
            rawJSON: raw,
            socketPath: file.socket?.path,
            hasSocketToken: !(file.socket?.token?.isEmpty ?? true),
            defaultSecurity: file.defaults?.security?.rawValue,
            defaultAsk: file.defaults?.ask?.rawValue,
            defaultAskFallback: file.defaults?.askFallback?.rawValue,
            autoAllowSkills: file.defaults?.autoAllowSkills,
            agentCount: agents.count,
            allowlistCount: allowlistCount)
    }

    private static func parse(_ raw: String) -> ExecApprovalsFile {
        guard let data = raw.data(using: .utf8),
              let file = try? JSONDecoder().decode(ExecApprovalsFile.self, from: data)
        else {
            return ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: nil)
        }
        return file
    }
}
