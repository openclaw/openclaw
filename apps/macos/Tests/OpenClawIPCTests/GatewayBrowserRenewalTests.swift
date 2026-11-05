import Foundation
import Testing
@testable import OpenClaw

struct GatewayBrowserRenewalTests {
    private let now = Date(timeIntervalSince1970: 2_000_000_000)

    private func session(lifetime: Double?, remaining: Double) throws -> GatewayBrowserSession {
        let expiry = self.now.addingTimeInterval(remaining)
        var claims = ["exp": expiry.timeIntervalSince1970]
        if let lifetime { claims["iat"] = expiry.timeIntervalSince1970 - lifetime }
        let payload = try JSONSerialization.data(withJSONObject: claims).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return try gatewayBrowserSessionFixture(token: "eyJhbGciOiJSUzI1NiJ9.\(payload).signature", expiresAt: expiry)
    }

    @Test(arguments: [
        (2_592_000.0, 604_800.0),
        (86400.0, 21600.0),
        (3600.0, 900.0),
        (600.0, 900.0),
        (0.0, 900.0),
        (-3600.0, 900.0),
    ])
    func `renewal window follows issued lifetime with bounded lead time`(lifetime: Double, expected: Double) throws {
        #expect(try self.session(lifetime: lifetime, remaining: 100).renewalLeadTime == expected)
    }

    @Test func `saved sessions without issued at keep fifteen minute renewal`() throws {
        let session = try self.session(lifetime: nil, remaining: 900)
        let restored = try JSONDecoder().decode(GatewayBrowserSession.self, from: JSONEncoder().encode(session))
        #expect(restored.renewalLeadTime == 900)
        #expect(try gatewayBrowserSessionFixture().renewalLeadTime == 900)
    }

    @Test(arguments: [
        (false, false, false), (false, false, true), (false, true, false), (false, true, true),
        (true, false, false), (true, false, true), (true, true, false), (true, true, true),
    ])
    func `automatic admission requires presence use and no current sign in`(
        present: Bool, inUse: Bool, signingIn: Bool) throws
    {
        var schedule = MacGatewayProfileStore.BrowserRenewalSchedule()
        let session = try self.session(lifetime: 86400, remaining: 21600)
        let admitted = schedule.admit(
            profileID: "saved",
            session: session,
            now: self.now,
            userPresent: present,
            inUse: inUse,
            alreadySigningIn: signingIn)
        #expect(admitted == (present && inUse && !signingIn))
        // A skipped background or in-flight check must not consume tomorrow's attempt.
        let next = schedule.admit(
            profileID: "saved",
            session: session,
            now: self.now,
            userPresent: true,
            inUse: true,
            alreadySigningIn: false)
        #expect(next == !admitted)
    }

    @Test(arguments: [-1.0, 0, 1, 21600, 21601])
    func `automatic admission only renews due unexpired sessions`(remaining: Double) throws {
        var schedule = MacGatewayProfileStore.BrowserRenewalSchedule()
        let admitted = try schedule.admit(
            profileID: "saved",
            session: self.session(lifetime: 86400, remaining: remaining),
            now: self.now,
            userPresent: true,
            inUse: true,
            alreadySigningIn: false)
        #expect(admitted == (remaining > 0 && remaining <= 21600))
        let manual = schedule.admit(
            profileID: "manual",
            session: nil,
            now: self.now,
            userPresent: true,
            inUse: true,
            alreadySigningIn: false)
        #expect(!manual)
    }

    @Test func `consecutive daily tokens each renew inside their own window`() throws {
        var schedule = MacGatewayProfileStore.BrowserRenewalSchedule()
        let hour = 3600.0
        func admit(_ session: GatewayBrowserSession, after elapsed: Double) -> Bool {
            schedule.admit(
                profileID: "saved",
                session: session,
                now: self.now.addingTimeInterval(elapsed),
                userPresent: true,
                inUse: true,
                alreadySigningIn: false)
        }
        // Hour 18 of a 24-hour token: its six-hour window is open.
        let first = try self.session(lifetime: 24 * hour, remaining: 6 * hour)
        #expect(admit(first, after: 0))
        // A failed attempt retries the same token after half its window.
        #expect(!admit(first, after: 2 * hour))
        #expect(admit(first, after: 3 * hour))
        // The renewed token expires 24 hours after the first renewal; its window
        // opens at its own hour 18, well before the previous attempt's day ends.
        let second = try self.session(lifetime: 24 * hour, remaining: 24 * hour)
        #expect(!admit(second, after: 17 * hour))
        #expect(admit(second, after: 18 * hour))
    }

    @Test func `automatic attempts are limited per profile for a full day even after failure`() throws {
        var schedule = MacGatewayProfileStore.BrowserRenewalSchedule()
        let session = try self.session(lifetime: 720 * 3600, remaining: 7 * 86400)
        for (elapsed, expected) in [(0.0, true), (86399.0, false), (86400.0, true)] {
            let admitted = schedule.admit(
                profileID: "saved",
                session: session,
                now: self.now.addingTimeInterval(elapsed),
                userPresent: true,
                inUse: true,
                alreadySigningIn: false)
            #expect(admitted == expected)
        }
        let another = schedule.admit(
            profileID: "another",
            session: session,
            now: self.now,
            userPresent: true,
            inUse: true,
            alreadySigningIn: false)
        #expect(another)
    }
}
