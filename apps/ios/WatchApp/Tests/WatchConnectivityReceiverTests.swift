import Testing

@testable import OpenClawWatch

@Suite("WatchConnectivityReceiver parsing")
struct WatchConnectivityReceiverTests {
    // MARK: - normalizeObject

    @Test func normalizeObjectPassthroughStringAnyDict() {
        let input: [String: Any] = ["key": "value", "num": 42]
        let result = WatchConnectivityReceiver.normalizeObject(input)
        #expect(result?["key"] as? String == "value")
        #expect(result?["num"] as? Int == 42)
    }

    @Test func normalizeObjectConvertsAnyHashableDict() {
        let input: [AnyHashable: Any] = ["a": 1, "b": "two"]
        let result = WatchConnectivityReceiver.normalizeObject(input)
        #expect(result?["a"] as? Int == 1)
        #expect(result?["b"] as? String == "two")
    }

    @Test func normalizeObjectSkipsNonStringKeysInAnyHashable() {
        let input: [AnyHashable: Any] = ["keep": true, 99: "skip"]
        let result = WatchConnectivityReceiver.normalizeObject(input)
        #expect(result?["keep"] as? Bool == true)
        #expect(result?.count == 1)
    }

    @Test func normalizeObjectReturnsNilForNonDict() {
        #expect(WatchConnectivityReceiver.normalizeObject("not a dict") == nil)
        #expect(WatchConnectivityReceiver.normalizeObject(42) == nil)
        #expect(WatchConnectivityReceiver.normalizeObject([1, 2, 3]) == nil)
    }

    // MARK: - parseActions

    @Test func parseActionsValidArray() {
        let raw: [Any] = [
            ["id": "a1", "label": "Approve", "style": "default"],
            ["id": "a2", "label": "Deny"],
        ]
        let actions = WatchConnectivityReceiver.parseActions(raw)
        #expect(actions.count == 2)
        #expect(actions[0].id == "a1")
        #expect(actions[0].label == "Approve")
        #expect(actions[0].style == "default")
        #expect(actions[1].style == nil)
    }

    @Test func parseActionsEmptyAndNil() {
        #expect(WatchConnectivityReceiver.parseActions(nil).isEmpty)
        #expect(WatchConnectivityReceiver.parseActions([] as [Any]).isEmpty)
    }

    @Test func parseActionsSkipsMalformedItems() {
        let raw: [Any] = [
            "not a dict",
            ["id": "", "label": "Valid"],       // empty id
            ["id": "ok", "label": ""],           // empty label
            ["id": "  ", "label": "  "],         // whitespace only
            ["id": "good", "label": "Good"],     // valid
        ]
        let actions = WatchConnectivityReceiver.parseActions(raw)
        #expect(actions.count == 1)
        #expect(actions[0].id == "good")
    }

    @Test func parseActionsTrimsWhitespace() {
        let raw: [Any] = [["id": "  x  ", "label": " OK ", "style": " bold "]]
        let actions = WatchConnectivityReceiver.parseActions(raw)
        #expect(actions[0].id == "x")
        #expect(actions[0].label == "OK")
        #expect(actions[0].style == "bold")
    }

    // MARK: - parseNotificationPayload

    @Test func parsePayloadValid() {
        let payload: [String: Any] = [
            "type": "watch.notify",
            "id": "msg-1",
            "title": "Alert",
            "body": "Something happened",
            "sentAtMs": 1_700_000_000_000,
            "promptId": "p-1",
            "sessionKey": "sk-1",
            "kind": "approval",
            "details": "More info",
            "expiresAtMs": 1_700_099_999_999,
            "risk": "high",
            "actions": [["id": "a1", "label": "Go"]],
        ]
        let msg = WatchConnectivityReceiver.parseNotificationPayload(payload)
        #expect(msg != nil)
        #expect(msg?.title == "Alert")
        #expect(msg?.body == "Something happened")
        #expect(msg?.risk == "high")
        #expect(msg?.actions.count == 1)
        #expect(msg?.sentAtMs == 1_700_000_000_000)
        #expect(msg?.expiresAtMs == 1_700_099_999_999)
    }

    @Test func parsePayloadRejectsWrongType() {
        let payload: [String: Any] = ["type": "other", "title": "T", "body": "B"]
        #expect(WatchConnectivityReceiver.parseNotificationPayload(payload) == nil)
    }

    @Test func parsePayloadRejectsMissingType() {
        let payload: [String: Any] = ["title": "T", "body": "B"]
        #expect(WatchConnectivityReceiver.parseNotificationPayload(payload) == nil)
    }

    @Test func parsePayloadRejectsEmptyTitleAndBody() {
        let payload: [String: Any] = ["type": "watch.notify", "title": "", "body": ""]
        #expect(WatchConnectivityReceiver.parseNotificationPayload(payload) == nil)
    }

    @Test func parsePayloadAcceptsBodyOnlyNoTitle() {
        let payload: [String: Any] = ["type": "watch.notify", "body": "Content"]
        let msg = WatchConnectivityReceiver.parseNotificationPayload(payload)
        #expect(msg != nil)
        #expect(msg?.title == "")
        #expect(msg?.body == "Content")
    }

    @Test func parsePayloadTrimsWhitespace() {
        let payload: [String: Any] = [
            "type": "watch.notify",
            "title": "  Padded  ",
            "body": "  text  ",
            "risk": "  HIGH  ",
        ]
        let msg = WatchConnectivityReceiver.parseNotificationPayload(payload)
        #expect(msg?.title == "Padded")
        #expect(msg?.body == "text")
        #expect(msg?.risk == "HIGH")
    }

    @Test func parsePayloadHandlesNSNumberSentAtMs() {
        let payload: [String: Any] = [
            "type": "watch.notify",
            "title": "T",
            "body": "B",
            "sentAtMs": NSNumber(value: 12345),
        ]
        let msg = WatchConnectivityReceiver.parseNotificationPayload(payload)
        #expect(msg?.sentAtMs == 12345)
    }
}
