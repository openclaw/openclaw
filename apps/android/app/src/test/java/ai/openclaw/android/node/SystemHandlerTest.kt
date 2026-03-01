package ai.openclaw.android.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemHandlerTest {
  @Test
  fun handleSystemNotify_rejectsUnauthorized() {
    val handler = SystemHandler.forTesting(poster = FakePoster(authorized = false))

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"hi"}""")

    assertFalse(result.ok)
    assertEquals("NOT_AUTHORIZED", result.error?.code)
  }

  @Test
  fun handleSystemNotify_rejectsEmptyNotification() {
    val handler = SystemHandler.forTesting(poster = FakePoster(authorized = true))

    val result = handler.handleSystemNotify("""{"title":"   ","body":"  "}""")

    assertFalse(result.ok)
    assertEquals("INVALID_REQUEST", result.error?.code)
  }

  @Test
  fun handleSystemNotify_postsNotification() {
    val poster = FakePoster(authorized = true)
    val handler = SystemHandler.forTesting(poster = poster)

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"done","priority":"active"}""")

    assertTrue(result.ok)
    assertEquals(1, poster.posts)
  }
}

private class FakePoster(
  private val authorized: Boolean,
) : SystemNotificationPoster {
  var posts: Int = 0
    private set

  override fun isAuthorized(): Boolean = authorized

  override fun post(request: SystemNotifyRequest) {
    posts += 1
  }
}
