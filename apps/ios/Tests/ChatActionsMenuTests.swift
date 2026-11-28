import Testing
@testable import OpenClaw

struct ChatActionsMenuTests {
    @Test func `a saved chat offers every section in order`() {
        let sections = ChatActionsMenu.sections(
            isMainChat: false,
            isSaved: true,
            hasInfoPage: true,
            hasContextUsage: true,
            canArchive: true,
            canDelete: true)
        #expect(sections == [
            [.newChat],
            [.pin, .moveToGroup],
            [.delete],
        ])
    }

    @Test func `the main chat has no New Chat, Archive or Delete`() {
        let sections = ChatActionsMenu.sections(
            isMainChat: true,
            isSaved: true,
            hasInfoPage: true,
            hasContextUsage: true,
            canArchive: false,
            canDelete: false)
        #expect(sections == [
            [.pin, .rename, .moveToGroup],
        ])
    }

    @Test func `a new chat before its first message offers only New Chat`() {
        let sections = ChatActionsMenu.sections(
            isMainChat: false,
            isSaved: false,
            hasInfoPage: false,
            hasContextUsage: false,
            canArchive: true,
            canDelete: true)
        #expect(sections == [[.newChat]])
    }
}
