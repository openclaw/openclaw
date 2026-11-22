import Foundation
import Testing
@testable import OpenClaw

struct ChatNotificationRequestTests {
    private let request = ChatNotificationRequest(
        notificationID: "synthetic-notification", gatewayDeviceId: "gateway-a", sessionKey: "agent:main:incident")

    @Test func parsesOnlyScopedDiagnosticPushDestinations() {
        let destination: [String: Any] = ["gatewayDeviceId": "gateway-a", "sessionKey": "agent:main:incident"]
        #expect(ChatNotificationRequest.parse(notificationID: "synthetic-notification", userInfo: [
            "openclaw": ["kind": "push.test", "destination": destination],
        ]) == self.request)
        let invalidPayloads: [[String: Any]] = [
            ["kind": "push.test"],
            ["kind": "other", "destination": destination],
            ["kind": "push.test", "destination": ["sessionKey": "agent:main:incident"]],
            ["kind": "push.test", "destination": ["gatewayDeviceId": "gateway-a", "sessionKey": ""]],
            ["kind": "push.test", "destination": ["gatewayDeviceId": "gateway-a", "sessionKey": 42]],
        ]
        for payload in invalidPayloads {
            #expect(ChatNotificationRequest.parse(notificationID: "synthetic-notification", userInfo: [
                "openclaw": payload,
            ]) == nil)
        }
    }

    @Test @MainActor func resolvesOnlyOnTheAuthorizedGatewayWithoutSending() async throws {
        var lookedUp: [String] = []
        let result = await self.request.resolve(
            gatewayIdentity: { "gateway-a" },
            session: { key in lookedUp.append(key); return key },
            isCurrent: { true })
        #expect(result == self.request.sessionKey)
        #expect(lookedUp == [self.request.sessionKey])
    }

    @Test @MainActor func wrongGatewayDoesNotEvenLookUpTheConversation() async throws {
        var lookedUp = false
        let result = await self.request.resolve(
            gatewayIdentity: { "gateway-b" },
            session: { _ in lookedUp = true; return self.request.sessionKey },
            isCurrent: { true })
        #expect(result == nil)
        #expect(!lookedUp)
    }

    @Test(arguments: [nil, "agent:main:another"] as [String?])
    @MainActor func missingInaccessibleOrRetargetedSessionsDoNotOpen(resolved: String?) async throws {
        let result = await self.request.resolve(
            gatewayIdentity: { "gateway-a" }, session: { _ in resolved }, isCurrent: { true })
        #expect(result == nil)
    }

    @Test(arguments: [true, false]) @MainActor
    func authorityChangesAcrossEitherAwaitDiscardTheDestination(duringIdentity: Bool) async throws {
        var current = true
        var lookedUp = false
        let result = await self.request.resolve(
            gatewayIdentity: {
                if duringIdentity { current = false }
                return "gateway-a"
            },
            session: { key in
                lookedUp = true
                current = false
                return key
            },
            isCurrent: { current })
        #expect(result == nil)
        #expect(lookedUp == !duringIdentity)
    }

    @Test @MainActor func revokedPairingCannotAuthorizeNavigation() async {
        enum Refusal: Error { case revoked }
        do {
            _ = try await self.request.resolve(
                gatewayIdentity: { throw Refusal.revoked },
                session: { _ in Issue.record("A revoked connection must not read the session"); return nil },
                isCurrent: { true })
            Issue.record("Expected the current connection's refusal")
        } catch Refusal.revoked {
            // The model keeps the current screen; the payload never grants access.
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }
}
