package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatBrowserTab
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatBrowserCardTest {
  @Test
  fun focusUrlPreservesGatewayMountAndExactSessionAndNodeIdentity() {
    assertEquals(
      "https://gateway.example.test:8443/openclaw/focus/browser?sessionKey=agent%3Aops%3Aproof%2Fone&target=node&profile=work%20browser&targetId=..&node=node%2Fone",
      chatBrowserUrl(
        "https://gateway.example.test:8443/openclaw?old=true#old",
        "agent:ops:proof/one",
        ChatBrowserTab("node", "node/one", "work browser", "..", "https://example.test", null),
      ),
    )
  }
}
