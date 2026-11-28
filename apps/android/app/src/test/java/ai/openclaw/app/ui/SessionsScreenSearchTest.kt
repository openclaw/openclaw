package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionsScreenSearchTest {
  @Test
  fun blankQueryShowsTheFilterEmptyStateOnlyAfterASuccessfulRead() {
    assertEquals(SessionEmptyMode.Filter, sessionEmptyMode("", loading = false))
    // Archived has no local roster: a pending or failed first read is not "No archived threads".
    assertEquals(SessionEmptyMode.Loading, sessionEmptyMode("   ", loading = true))
    assertEquals(SessionEmptyMode.Unavailable, sessionEmptyMode("", loading = false, unavailable = true))
  }

  @Test
  fun nonBlankSearchDistinguishesLoadingNoMatchesAndAFailedRead() {
    assertEquals(SessionEmptyMode.SearchLoading, sessionEmptyMode("zzproof", loading = true))
    assertEquals(SessionEmptyMode.SearchNoMatches, sessionEmptyMode("zzproof", loading = false))
    assertEquals(SessionEmptyMode.Unavailable, sessionEmptyMode("zzproof", loading = false, unavailable = true))
  }
}
