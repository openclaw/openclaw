package ai.openclaw.wear.shared

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream

class WearRealtimeTalkTest {
  @Test
  fun audioFramesRoundTripAndPreserveBoundaries() {
    val output = ByteArrayOutputStream()
    WearRealtimeAudioFraming.write(output, WearRealtimeAudioFrameType.INPUT_PCM, byteArrayOf(1, 2, 3, 4))
    WearRealtimeAudioFraming.write(output, WearRealtimeAudioFrameType.INPUT_PCM, byteArrayOf(5, 6, 7, 8))
    WearRealtimeAudioFraming.write(output, WearRealtimeAudioFrameType.CLEAR_OUTPUT, byteArrayOf())
    val input = ByteArrayInputStream(output.toByteArray())

    val audio = WearRealtimeAudioFraming.read(input)!!
    assertEquals(WearRealtimeAudioFrameType.INPUT_PCM, audio.type)
    assertArrayEquals(byteArrayOf(5, 6, 7, 8), WearRealtimeAudioFraming.read(input)!!.payload)
    assertArrayEquals(byteArrayOf(1, 2, 3, 4), audio.payload)
    assertEquals(WearRealtimeAudioFrameType.CLEAR_OUTPUT, WearRealtimeAudioFraming.read(input)!!.type)
    assertNull(WearRealtimeAudioFraming.read(input))
  }

  @Test
  fun rejectsInvalidPcmAndClearPayloadsAtTheReader() {
    val invalidFrames =
      listOf(
        WearRealtimeAudioFrameType.INPUT_PCM to byteArrayOf(),
        WearRealtimeAudioFrameType.INPUT_PCM to byteArrayOf(1),
        WearRealtimeAudioFrameType.OUTPUT_PCM to byteArrayOf(),
        WearRealtimeAudioFrameType.OUTPUT_PCM to byteArrayOf(1),
        WearRealtimeAudioFrameType.CLEAR_OUTPUT to byteArrayOf(1, 2),
      )
    for ((type, payload) in invalidFrames) {
      val output = ByteArrayOutputStream()
      DataOutputStream(output).apply {
        writeByte(type.wireValue)
        writeInt(payload.size)
        write(payload)
      }
      assertThrows(IllegalArgumentException::class.java) {
        WearRealtimeAudioFraming.read(ByteArrayInputStream(output.toByteArray()))
      }
    }
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsOversizedFrameBeforeAllocatingPayload() {
    val output = ByteArrayOutputStream()
    DataOutputStream(output).apply {
      writeByte(WearRealtimeAudioFrameType.INPUT_PCM.wireValue)
      writeInt(WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES + 1)
    }
    WearRealtimeAudioFraming.read(ByteArrayInputStream(output.toByteArray()))
  }
}
