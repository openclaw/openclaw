package ai.openclaw.app.auto

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import androidx.car.app.testing.TestCarContext
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAudioManager

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CarE2eFlowTest {

  private lateinit var context: Context
  private lateinit var carAudioController: CarAudioController
  private lateinit var vehicleActionController: CarVehicleActionController
  private lateinit var notificationHandler: CarNotificationHandler
  private lateinit var commandHandler: CarCommandHandler
  private lateinit var invokeBridge: CarInvokeBridge

  @Before
  fun setUp() {
    context = ApplicationProvider.getApplicationContext()
    carAudioController = CarAudioController(context)
    vehicleActionController = CarVehicleActionController(context)
    notificationHandler = CarNotificationHandler(context)
    commandHandler = CarCommandHandler(context, vehicleActionController, notificationHandler)
    invokeBridge = CarInvokeBridge(context, commandHandler)
  }

  @Test
  fun testE2eAudioDuckingAndVoiceWakeSimulation() {
    var focusLostTriggered = false
    val focusGranted = carAudioController.requestCarFocus {
      focusLostTriggered = true
    }
    assertTrue("Car audio focus must be granted to speech pipeline", focusGranted)

    // Simula liberação após término da conversa
    carAudioController.abandonCarFocus()
  }

  @Test
  fun testE2eVoiceCommandToNavigation() = kotlinx.coroutines.runBlocking {
    val destination = "Aeroporto de Guarulhos"
    val rpcPayload = "{\"destination\":\"$destination\"}"

    val result = invokeBridge.handleCarCommand("car.navigate", rpcPayload)
    assertTrue("RPC command car.navigate should succeed", result.isOk)

    // Verifica intent gerada no Android
    val shadowApp = Shadows.shadowOf(ApplicationProvider.getApplicationContext() as android.app.Application)
    val nextIntent = shadowApp.nextStartedActivity
    assertNotNull("Navigation intent should have been fired", nextIntent)
    assertEquals(Intent.ACTION_VIEW, nextIntent.action)
    assertTrue("Intent URI should target navigation", nextIntent.dataString?.contains("google.navigation:q=") == true)
  }

  @Test
  fun testE2eVoiceCommandToMediaPlayback() = kotlinx.coroutines.runBlocking {
    val song = "Queen Bohemian Rhapsody"
    val rpcPayload = "{\"action\":\"search_play\",\"query\":\"$song\"}"

    val result = invokeBridge.handleCarCommand("car.media", rpcPayload)
    assertTrue("RPC command car.media search_play should succeed", result.isOk)

    val shadowApp = Shadows.shadowOf(ApplicationProvider.getApplicationContext() as android.app.Application)
    val nextIntent = shadowApp.nextStartedActivity
    assertNotNull("Media search intent should have been fired", nextIntent)
    assertEquals(android.provider.MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH, nextIntent.action)
  }

  @Test
  fun testE2eCarNotificationAlert() = kotlinx.coroutines.runBlocking {
    val rpcPayload = "{\"title\":\"Alerta IA\",\"message\":\"Mensagem urgente da central\"}"
    val result = invokeBridge.handleCarCommand("car.alert", rpcPayload)
    assertTrue("RPC car.alert should succeed", result.isOk)
  }
}
