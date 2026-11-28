import CryptoKit
import Foundation

/// The node's prepared file binding is authenticated with the rest of the socket request.
struct ExecApprovalScriptOperand: Codable, Sendable {
    let argvIndex: Int
    let path: String
    let sha256: String

    func isCurrent(command: [String], cwd: String) -> Bool {
        guard command.indices.contains(self.argvIndex) else { return false }
        let operand = command[self.argvIndex]
        guard !operand.isEmpty, !operand.contains("\0") else { return false }
        let candidate = operand.hasPrefix("/")
            ? URL(fileURLWithPath: operand)
            : URL(fileURLWithPath: cwd, isDirectory: true).appendingPathComponent(operand)
        let resolved = candidate.resolvingSymlinksInPath()
        guard resolved.path == self.path,
              (try? resolved.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
              let bytes = try? Data(contentsOf: resolved)
        else { return false }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() == self.sha256
    }
}
