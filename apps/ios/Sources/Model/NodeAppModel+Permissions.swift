import Foundation
import UIKit

@MainActor
extension NodeAppModel {
    func permissionSnapshot() -> IOSPermissionSnapshot {
        IOSPermissionCenter.statusSnapshot()
    }

    @discardableResult
    func requestPermission(_ permission: IOSPermissionKind) async -> IOSPermissionSnapshot {
        _ = await IOSPermissionCenter.request(permission)
        return IOSPermissionCenter.statusSnapshot()
    }

    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            return
        }
        UIApplication.shared.open(url)
    }
}
