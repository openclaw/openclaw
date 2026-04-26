package ai.openclaw.app.buddy

import org.junit.Assert.assertEquals
import org.junit.Test

class BuddyModelsTest {
  @Test
  fun defaultSnapshotUsesNemoIdentity() {
    val snapshot = BuddySnapshot.listening()

    assertEquals("Nemo", snapshot.agent.name)
    assertEquals("NemoNemo", snapshot.voice.wakeWord)
    assertEquals(BuddyState.Listening, snapshot.state)
    assertEquals(BuddyMood.Calm, snapshot.agent.mood)
  }

  @Test
  fun priorityChoosesPermissionBeforeConfirmationAndRecording() {
    val state =
      BuddyState.resolve(
        permissionRequired = true,
        confirmationRequired = true,
        recording = true,
        visionScanning = true,
        speaking = true,
        thinking = true,
        connected = true,
      )

    assertEquals(BuddyState.PermissionRequired, state)
  }

  @Test
  fun priorityChoosesConfirmationBeforeRecording() {
    val state =
      BuddyState.resolve(
        permissionRequired = false,
        confirmationRequired = true,
        recording = true,
        visionScanning = false,
        speaking = false,
        thinking = false,
        connected = true,
      )

    assertEquals(BuddyState.NeedsConfirmation, state)
  }

  @Test
  fun priorityChoosesRecordingBeforeVision() {
    val state =
      BuddyState.resolve(
        permissionRequired = false,
        confirmationRequired = false,
        recording = true,
        visionScanning = true,
        speaking = true,
        thinking = true,
        connected = true,
      )

    assertEquals(BuddyState.Recording, state)
  }

  @Test
  fun priorityChoosesVisionBeforeSpeaking() {
    val state =
      BuddyState.resolve(
        permissionRequired = false,
        confirmationRequired = false,
        recording = false,
        visionScanning = true,
        speaking = true,
        thinking = true,
        connected = true,
      )

    assertEquals(BuddyState.VisionScanning, state)
  }

  @Test
  fun priorityChoosesSpeakingBeforeThinking() {
    val state =
      BuddyState.resolve(
        permissionRequired = false,
        confirmationRequired = false,
        recording = false,
        visionScanning = false,
        speaking = true,
        thinking = true,
        connected = true,
      )

    assertEquals(BuddyState.Speaking, state)
  }

  @Test
  fun priorityChoosesThinkingBeforeDisconnected() {
    val state =
      BuddyState.resolve(
        permissionRequired = false,
        confirmationRequired = false,
        recording = false,
        visionScanning = false,
        speaking = false,
        thinking = true,
        connected = false,
      )

    assertEquals(BuddyState.Thinking, state)
  }

  @Test
  fun priorityChoosesDisconnectedWithoutActiveState() {
    val state =
      BuddyState.resolve(
        permissionRequired = false,
        confirmationRequired = false,
        recording = false,
        visionScanning = false,
        speaking = false,
        thinking = false,
        connected = false,
      )

    assertEquals(BuddyState.Disconnected, state)
  }

  @Test
  fun priorityChoosesListeningFallbackWhenConnected() {
    val state =
      BuddyState.resolve(
        permissionRequired = false,
        confirmationRequired = false,
        recording = false,
        visionScanning = false,
        speaking = false,
        thinking = false,
        connected = true,
      )

    assertEquals(BuddyState.Listening, state)
  }
}
