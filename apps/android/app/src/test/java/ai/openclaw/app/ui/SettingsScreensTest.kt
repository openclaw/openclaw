package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsScreensTest {
  @Test
  fun androidDistributionChannelUsesBuildFlavorLabels() {
    assertEquals("Play", androidDistributionChannel("play"))
    assertEquals("Third-party", androidDistributionChannel("thirdParty"))
    assertEquals("Unknown", androidDistributionChannel(""))
  }

  @Test
  fun gatewaySetupResetCopyExplainsCredentialAndApprovalImpact() {
    val text = gatewaySettingsSetupResetConfirmationText()

    assertEquals(true, text.contains("saved setup credentials"))
    assertEquals(true, text.contains("device tokens"))
    assertEquals(true, text.contains("node capability approval"))
  }

  @Test
  fun devicePairingAdminCopySeparatesPairingFromNodeApproval() {
    val text = devicePairingAdminUnavailableText()

    assertEquals(true, text.contains("approve new phone pairing"))
    assertEquals(true, text.contains("Node capability approval is separate"))
    assertEquals(true, text.contains("nodes approve <request id>"))
  }
}
