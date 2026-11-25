import ESPProvision
import Foundation
import XCTest

final class Security2AdvertisementTests: XCTestCase {
    private final class Credentials: ESPDeviceConnectionDelegate {
        var requests = 0
        func getProofOfPossesion(forDevice: ESPDevice, completionHandler: @escaping (String) -> Void) {
            self.requests += 1
            // Do not continue into a radio handshake in this owner-boundary test.
        }

        func getUsername(forDevice: ESPDevice, completionHandler: @escaping (String?) -> Void) {
            self.requests += 1
        }
    }

    func testRejectsDowngradeBeforeRequestingCredentials() {
        ESPProvisionManager.shared.enableLogs(false)
        let advertisements: [NSDictionary?] = [
            nil, [:], ["prov": "invalid"], ["prov": ["sec_ver": 1, "sec_patch_ver": 1]],
            ["prov": ["sec_ver": 2, "sec_patch_ver": 0]],
            ["prov": ["sec_ver": true, "sec_patch_ver": 1]],
            ["prov": ["sec_ver": 2, "sec_patch_ver": true]],
            ["prov": ["sec_ver": 2.1, "sec_patch_ver": 1]],
            ["prov": ["sec_ver": 2, "sec_patch_ver": "1"]],
        ]
        for advertisement in advertisements {
            let credentials = Credentials()
            let device = ESPDevice(name: "fixture", security: .secure2, transport: .ble)
            device.delegate = credentials
            device.versionInfo = advertisement
            var rejected = false
            device.initialiseSession(sessionPath: nil) { status in
                if case .failedToConnect(.securityMismatch) = status { rejected = true }
            }
            XCTAssertTrue(rejected)
            XCTAssertEqual(credentials.requests, 0)
        }
    }

    func testCounterVariantPassesToCredentialBoundaryWithoutStartingBLE() {
        let credentials = Credentials()
        let device = ESPDevice(name: "fixture", security: .secure2, transport: .ble)
        device.delegate = credentials
        device.versionInfo = ["prov": ["sec_ver": 2, "sec_patch_ver": 1]]
        device.initialiseSession(sessionPath: nil) { _ in XCTFail("No handshake was started") }
        XCTAssertEqual(credentials.requests, 1)
    }
}
