package ai.openclaw.app.auto

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CarVehicleActionControllerTest {

  private lateinit var context: Context
  private lateinit var controller: CarVehicleActionController
  private lateinit var notificationHandler: CarNotificationHandler
  private lateinit var commandHandler: CarCommandHandler
  private lateinit var invokeBridge: CarInvokeBridge

  @Before
  fun setUp() {
    context = ApplicationProvider.getApplicationContext()
    controller = CarVehicleActionController(context)
    notificationHandler = CarNotificationHandler(context)
    commandHandler = CarCommandHandler(context, controller, notificationHandler)
    invokeBridge = CarInvokeBridge(context, commandHandler)
  }

  @Test
  fun testNavigateCommandSuccess() {
    val result = commandHandler.handleNavigate("{\"destination\":\"Av Paulista, 1000\"}")
    assertNotNull(result)
    assertTrue(result.isOk)
  }

  @Test
  fun testMediaPlayPauseSuccess() {
    val result = commandHandler.handleMedia("{\"action\":\"play_pause\"}")
    assertNotNull(result)
    assertTrue(result.isOk)
  }

  @Test
  fun testCarAlertSuccess() {
    val result = commandHandler.handleAlert("{\"title\":\"Aviso\",\"message\":\"Radar à frente\"}")
    assertNotNull(result)
    assertTrue(result.isOk)
  }

  @Test
  fun testInvokeBridgeRoutesProperly() = kotlinx.coroutines.runBlocking {
    val navResult = invokeBridge.handleCarCommand("car.navigate", "{\"destination\":\"Shopping\"}")
    assertTrue(navResult.isOk)

    val errResult = invokeBridge.handleCarCommand("car.unknown", null)
    assertTrue(!errResult.isOk)
  }
}
