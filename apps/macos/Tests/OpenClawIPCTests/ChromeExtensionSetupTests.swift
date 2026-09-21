import Testing
@testable import OpenClaw

struct ChromeExtensionSetupTests {
    @Test func `registration and a pending install request do not imply installed`() throws {
        let result = try ChromeExtensionSetup.readResult("""
        {"registrations":[{"product":"chrome","state":"owned"}],"storeInstallRequests":[{"state":"requested"}],
         "storeDiscovered":[],"discovered":[]}
        """)
        #expect(result.nativeHostRegistered)
        #expect(result.installRequested)
        #expect(result.installedProfiles == 0)
        #expect(result.discoveredProfiles == 0)
    }

    @Test func `installed profiles include disabled Store extensions separately from enabled profiles`() throws {
        let result = try ChromeExtensionSetup.readResult("""
        {"registrations":[{"product":"chrome","state":"foreign"}],"storeInstallRequests":[{"state":"foreign"}],
         "storeDiscovered":[{"product":"chrome","enabled":false},{"product":"chrome","enabled":true}],
         "discovered":[{"product":"chrome"}]}
        """)
        #expect(!result.nativeHostRegistered)
        #expect(!result.installRequested)
        #expect(result.installedProfiles == 3)
        #expect(result.discoveredProfiles == 2)
    }

    @Test func `another browser cannot mask failed Chrome registration or pending approval`() throws {
        let result = try ChromeExtensionSetup.readResult("""
        {"registrations":[{"product":"chromium","state":"owned"},
          {"product":"chrome","state":"owned","issue":"runtime unavailable"}],
         "storeInstallRequests":[{"state":"requested"}],
         "storeDiscovered":[{"product":"chrome","enabled":false,"awaitingApproval":true},
          {"product":"chromium","enabled":true}],
         "discovered":[{"product":"chrome-for-testing"}]}
        """)
        #expect(!result.nativeHostRegistered)
        #expect(result.installedProfiles == 1)
        #expect(result.discoveredProfiles == 0)
        #expect(result.installRequested)
    }
}
