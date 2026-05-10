import Foundation

enum ExecApprovalsSQLiteStateStore {
    private static let stateScope = "exec.approvals"
    private static let stateKey = "current"

    static func databaseURL() -> URL {
        OpenClawSQLiteKVStore.databaseURL()
    }

    static func storeLocationForDisplay() -> String {
        OpenClawSQLiteKVStore.storeLocationForDisplay(scope: self.stateScope, key: self.stateKey)
    }

    static func readRawState() -> String? {
        OpenClawSQLiteKVStore.readString(scope: self.stateScope, key: self.stateKey)
    }

    static func writeRawState(_ raw: String) throws {
        try OpenClawSQLiteKVStore.writeString(scope: self.stateScope, key: self.stateKey, value: raw)
    }
}
