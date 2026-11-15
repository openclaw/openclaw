import Testing
@testable import OpenClaw

/// Regression coverage for the workspace Files pagination cursor
/// (#193500): the request offset tracks server progress, never the
/// deduplicated local row count, and a stalled final page detects drift.
struct AgentWorkspaceFilesPaginationTests {
    @Test func `static folder completes without drift`() {
        var pagination = WorkspaceListPagination()

        #expect(pagination.nextOffset == 0)
        #expect(pagination.consume(
            requestOffset: 0,
            fetchedCount: 250,
            totalEntries: 251,
            localRowCount: 250) == .advanced)
        #expect(pagination.nextOffset == 250)
        #expect(pagination.consume(
            requestOffset: 250,
            fetchedCount: 1,
            totalEntries: 251,
            localRowCount: 251) == .advanced)
        #expect(pagination.nextOffset == 251)
    }

    @Test func `insertion before the cursor detects drift on the final page`() {
        var pagination = WorkspaceListPagination()

        // Page 1 of a 251-entry folder.
        #expect(pagination.consume(
            requestOffset: 0,
            fetchedCount: 250,
            totalEntries: 251,
            localRowCount: 250) == .advanced)
        // A file sorts in before the cursor, so the total grows to 252 and
        // the page at offset 250 overlaps the local list: one of its rows
        // dedupes away and the local count stays below the total. That
        // stalled final page is the drift signal.
        #expect(pagination.consume(
            requestOffset: 250,
            fetchedCount: 2,
            totalEntries: 252,
            localRowCount: 251) == .driftDetected)
        #expect(pagination.nextOffset == 252)
    }

    @Test func `deletion before the cursor detects drift`() {
        var pagination = WorkspaceListPagination()

        #expect(pagination.consume(
            requestOffset: 0,
            fetchedCount: 250,
            totalEntries: 251,
            localRowCount: 250) == .advanced)
        // A file before the cursor is deleted: the last row shifts into the
        // already-served offsets, so the offset-250 page comes back empty
        // while local rows already equal the shrunken total.
        #expect(pagination.consume(
            requestOffset: 250,
            fetchedCount: 0,
            totalEntries: 250,
            localRowCount: 250) == .driftDetected)
    }

    @Test func `reload recovers a drifted listing and finishes pagination`() {
        var pagination = WorkspaceListPagination()

        // Stalled at 251 of 252 after an insertion.
        _ = pagination.consume(
            requestOffset: 0,
            fetchedCount: 250,
            totalEntries: 251,
            localRowCount: 250)
        #expect(pagination.consume(
            requestOffset: 250,
            fetchedCount: 2,
            totalEntries: 252,
            localRowCount: 251) == .driftDetected)

        // Reload restarts from the top of the now-stable 252-entry folder;
        // the second pass completes without drift and the Load More row
        // disappears because local rows equal the total.
        pagination.reset()
        #expect(pagination.nextOffset == 0)
        _ = pagination.consume(
            requestOffset: 0,
            fetchedCount: 250,
            totalEntries: 252,
            localRowCount: 250)
        #expect(pagination.nextOffset == 250)
        #expect(pagination.consume(
            requestOffset: 250,
            fetchedCount: 2,
            totalEntries: 252,
            localRowCount: 252) == .advanced)
        #expect(pagination.nextOffset == 252)
    }

    // A failed page request never calls consume, so the cursor and the
    // Load More row survive for retry; the state machine has no failure
    // state of its own.
}
