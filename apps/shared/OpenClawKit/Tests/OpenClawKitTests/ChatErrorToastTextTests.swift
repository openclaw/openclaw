import Testing
@testable import OpenClawChatUI

struct ChatErrorToastTextTests {
    @Test func `a failure over a transcript becomes the toast's words`() {
        #expect(chatErrorToastText("Couldn’t change the model.", transcriptHasContent: true) ==
            "Couldn’t change the model.")
        #expect(chatErrorToastText("  Couldn’t fork this chat.\n", transcriptHasContent: true) ==
            "Couldn’t fork this chat.")
    }

    @Test func `failures with another home never become a toast`() {
        // An empty transcript shows the failure in place, with Refresh.
        #expect(chatErrorToastText("Couldn’t load this chat.", transcriptHasContent: false) == nil)
        // A lost connection has its own notice.
        #expect(chatErrorToastText("gateway not connected", transcriptHasContent: true) == nil)
        // Missing plans on an older Gateway aren't something the person just did.
        #expect(chatErrorToastText(
            OpenClawChatTransportUpgradeMessage.progressCardAgentScope, transcriptHasContent: true) == nil)
        #expect(chatErrorToastText(nil, transcriptHasContent: true) == nil)
        #expect(chatErrorToastText(" ", transcriptHasContent: true) == nil)
    }
}
