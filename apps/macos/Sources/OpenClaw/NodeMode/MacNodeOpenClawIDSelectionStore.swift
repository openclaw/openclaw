import Foundation
import OpenClawKit

/// Profile preferences select an enrollment; the native trust store and Keychain retain authority and W.
@MainActor
final class MacNodeOpenClawIDSelectionStore {
    static let shared = MacNodeOpenClawIDSelectionStore(
        defaults: AppDefaults.standard,
        databaseURL: AppProfile.current.stateDirectoryURL().appendingPathComponent("node-enrollment.sqlite"))

    enum LoadError: Error { case invalidSelection }

    private let defaults: UserDefaults
    private let key = "openclaw.mac.node.openClawID.target"
    let databaseURL: URL

    init(defaults: UserDefaults, databaseURL: URL) {
        self.defaults = defaults
        self.databaseURL = databaseURL
    }

    func load() throws -> MacNodeOpenClawIDTarget? {
        guard let stored = self.defaults.object(forKey: self.key) else { return nil }
        guard let fields = stored as? [String: String],
              let hostname = fields["hostname"], !hostname.isEmpty,
              let rawID = fields["enrollmentID"], let enrollmentID = UUID(uuidString: rawID)
        else { throw LoadError.invalidSelection }
        return MacNodeOpenClawIDTarget(
            hostname: hostname,
            enrollmentID: enrollmentID,
            databaseURL: self.databaseURL,
            identityStore: OpenClawIDNodeIdentityKeychainStore(enrollmentID: enrollmentID))
    }

    func save(_ target: MacNodeOpenClawIDTarget?) {
        guard let target else {
            self.defaults.removeObject(forKey: self.key)
            return
        }
        self.defaults.set([
            "hostname": target.hostname,
            "enrollmentID": target.enrollmentID.uuidString,
        ], forKey: self.key)
    }
}
