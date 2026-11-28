import Testing
@testable import OpenClaw

struct ChatActionsMenuTests {
    @Test func `a saved chat offers every section in order`() {
        let sections = ChatActionsMenu.sections(
            isMainChat: false, isSaved: true, hasContextUsage: true, canArchive: true, canDelete: true)
        #expect(sections == [
            [.newChat],
            [.pin, .rename, .moveToGroup],
            [.contextUsage],
            [.archive, .delete],
        ])
    }

    @Test func `the main chat has no New Chat, Archive or Delete`() {
        let sections = ChatActionsMenu.sections(
            isMainChat: true, isSaved: true, hasContextUsage: true, canArchive: false, canDelete: false)
        #expect(sections == [
            [.pin, .rename, .moveToGroup],
            [.contextUsage],
        ])
    }

    @Test func `a new chat before its first message offers only New Chat`() {
        let sections = ChatActionsMenu.sections(
            isMainChat: false, isSaved: false, hasContextUsage: false, canArchive: true, canDelete: true)
        #expect(sections == [[.newChat]])
    }
}
