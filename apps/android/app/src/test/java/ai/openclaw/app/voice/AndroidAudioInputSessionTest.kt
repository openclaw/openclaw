package ai.openclaw.app.voice

import android.Manifest
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Looper
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.AudioDeviceInfoBuilder
import org.robolectric.shadows.ShadowAudioManager
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidAudioInputSessionTest {
  private val context = RuntimeEnvironment.getApplication()
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val shadowAudioManager: ShadowAudioManager = shadowOf(audioManager)
  private var nextDeviceId = 1

  @Before
  fun setUp() {
    shadowOf(context).grantPermissions(Manifest.permission.RECORD_AUDIO)
  }

  @After
  fun tearDown() {
    shadowAudioManager.setInputDevices(emptyList())
    shadowAudioManager.setAvailableCommunicationDevices(emptyList())
    audioManager.clearCommunicationDevice()
  }

  @Test
  fun prefersBleHeadsetInputAndCommunicationRoute() {
    val sco = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val scoOutput = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val bleOutput = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    shadowAudioManager.setInputDevices(listOf(sco, ble))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(scoOutput, bleOutput))

    val session = AndroidAudioInputSession.open(context, sampleRateHz = 24_000, frameBytes = 4_800)

    assertEquals(AudioDeviceInfo.TYPE_BLE_HEADSET, session.requestedInputType)
    assertEquals(AudioDeviceInfo.TYPE_BLE_HEADSET, audioManager.communicationDevice?.type)
    session.close()
  }

  @Test
  fun removalFallsBackToClassicBluetoothInput() {
    val sco = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val scoOutput = audioDevice(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    val bleOutput = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    shadowAudioManager.setInputDevices(listOf(sco, ble))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(scoOutput, bleOutput))
    val session = AndroidAudioInputSession.open(context, sampleRateHz = 24_000, frameBytes = 4_800)

    shadowAudioManager.setAvailableCommunicationDevices(listOf(scoOutput))
    shadowAudioManager.removeInputDevice(ble, true)
    shadowOf(Looper.getMainLooper()).idle()

    assertEquals(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, session.requestedInputType)
    assertEquals(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, audioManager.communicationDevice?.type)
    session.close()
  }

  @Test
  fun closeRestoresDefaultInputAndUnregistersDeviceCallback() {
    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val bleOutput = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    shadowAudioManager.setInputDevices(listOf(ble))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(bleOutput))
    val session = AndroidAudioInputSession.open(context, sampleRateHz = 8_000, frameBytes = 1_600)

    session.close()

    assertNull(session.requestedInputType)
    assertNull(audioManager.communicationDevice)
    shadowAudioManager.addInputDevice(audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET), true)
    shadowOf(Looper.getMainLooper()).idle()
    assertNull(session.requestedInputType)
  }

  @Test
  fun delayedOldCloseDoesNotClearNewerCommunicationRoute() {
    val ble = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    val bleOutput = audioDevice(AudioDeviceInfo.TYPE_BLE_HEADSET)
    shadowAudioManager.setInputDevices(listOf(ble))
    shadowAudioManager.setAvailableCommunicationDevices(listOf(bleOutput))
    val oldSession = AndroidAudioInputSession.open(context, sampleRateHz = 24_000, frameBytes = 4_800)
    val newSession = AndroidAudioInputSession.open(context, sampleRateHz = 24_000, frameBytes = 4_800)

    oldSession.close()

    assertEquals(AudioDeviceInfo.TYPE_BLE_HEADSET, audioManager.communicationDevice?.type)
    newSession.close()
    assertNull(audioManager.communicationDevice)
  }

  private fun audioDevice(type: Int): AudioDeviceInfo {
    val device =
      AudioDeviceInfoBuilder
        .newBuilder()
        .setType(type)
        .build()
    val port = ReflectionHelpers.getField<Any>(device, "mPort")
    val handle = ReflectionHelpers.getField<Any>(port, "mHandle")
    ReflectionHelpers.setField(handle, "mId", nextDeviceId++)
    return device
  }
}
