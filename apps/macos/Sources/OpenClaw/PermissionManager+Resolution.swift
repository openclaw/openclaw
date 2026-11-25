import OpenClawIPC
import OpenClawKit

extension PermissionManager {
    @MainActor
    static func resolve(
        _ capabilities: [Capability],
        location: LocationPermissionRequester = .shared,
        isCurrent: @escaping @MainActor () -> Bool,
        enable: @MainActor (Capability) async throws -> Bool) async rethrows
    {
        for capability in capabilities {
            guard isCurrent() else { return }
            if capability == .location {
                let status = location.authorizationStatus
                if status == .denied || status == .restricted {
                    // Opening Settings does not enable Location. Consent belongs to the later enable action.
                    _ = await location.request(always: false, isCurrent: isCurrent)
                    return
                }
            }
            guard try await enable(capability) else { return }
        }
        var missingStates: [(Capability, OpenClawPermissionState)] = []
        for capability in capabilities {
            if let state = await self.missingState(capability) {
                missingStates.append((capability, state))
            }
            guard isCurrent() else { return }
        }
        guard let remediation = self.primaryRemediation(missingStates) else { return }
        for capability in remediation.capabilities {
            guard isCurrent() else { return }
            switch remediation.state {
            case .restartRequired:
                DebugActions.restartApp()
                return
            case .denied, .staleGrant:
                SystemSettingsURLSupport.openFirst(SystemSettingsURLSupport.settingsCandidates(for: capability))
            case .notDetermined:
                _ = await self.ensure([capability], interactive: true, isCurrent: isCurrent)
            case .disabledInOpenClaw:
                break
            }
        }
    }
}
