package ai.openclaw.app

import ai.openclaw.app.gateway.CloudflareAccessNativeTest
import ai.openclaw.app.gateway.GatewaySessionTlsNativeTest
import ai.openclaw.app.ui.chat.ChatInlineWidgetTlsNativeTest
import org.junit.runner.RunWith
import org.junit.runners.Suite

// AGP 9.4's engine serializes runner arguments as CSV, truncating comma-separated class values.
// A standard single-class suite preserves every child test without changing its assertions.
@RunWith(Suite::class)
@Suite.SuiteClasses(
  CloudflareAccessNativeTest::class,
  GatewaySessionTlsNativeTest::class,
  ChatInlineWidgetTlsNativeTest::class,
)
class NativeTransportQualificationSuite
