import Security
import Testing
@testable import OpenClaw

struct GatewayKeychainAccessTests {
    @Test(arguments: [errSecUserCanceled, errSecAuthFailed])
    func `denied access suppresses subsequent operations until explicit retry`(_ denial: OSStatus) {
        var access = GatewayKeychainAccess()
        var operations = 0
        #expect(access.perform {
            operations += 1
            return denial
        } == denial)

        // Even if the Keychain becomes available, background work must respect the denial.
        for _ in 0..<2 {
            #expect(access.perform {
                operations += 1
                return errSecSuccess
            } == denial)
        }
        #expect(operations == 1)

        access.allowRetry()
        #expect(access.perform {
            operations += 1
            return errSecSuccess
        } == errSecSuccess)
        #expect(operations == 2)

        // A newly denied explicit attempt must suppress automatic operations again.
        #expect(access.perform { denial } == denial)
        #expect(access.perform { errSecSuccess } == denial)
    }

    @Test(arguments: [
        errSecSuccess, errSecItemNotFound, errSecNotAvailable, errSecDuplicateItem,
        errSecInteractionNotAllowed, errSecInteractionRequired,
    ])
    func `non-denial results allow subsequent Keychain operations`(_ status: OSStatus) {
        var access = GatewayKeychainAccess()
        #expect(access.perform { status } == status)
        #expect(access.perform { errSecSuccess } == errSecSuccess)
    }
}
