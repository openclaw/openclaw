package ai.openclaw.app.auto

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.view.KeyEvent

class CarVehicleActionController(private val context: Context) {

  fun navigateTo(destinationQuery: String): Boolean {
    return runCatching {
      val uri = Uri.parse("google.navigation:q=" + Uri.encode(destinationQuery))
      val intent = Intent(Intent.ACTION_VIEW, uri).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
      true
    }.getOrElse {
      val geoUri = Uri.parse("geo:0,0?q=" + Uri.encode(destinationQuery))
      val fallbackIntent = Intent(Intent.ACTION_VIEW, geoUri).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      runCatching {
        context.startActivity(fallbackIntent)
        true
      }.getOrDefault(false)
    }
  }

  fun playMediaSearch(mediaQuery: String): Boolean {
    return runCatching {
      val intent = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH).apply {
        putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
        putExtra(MediaStore.EXTRA_MEDIA_TITLE, mediaQuery)
        putExtra("query", mediaQuery)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
      true
    }.getOrDefault(false)
  }

  fun sendMediaKeyEvent(keyCode: Int): Boolean {
    return runCatching {
      val down = Intent(Intent.ACTION_MEDIA_BUTTON).apply {
        putExtra(Intent.EXTRA_KEY_EVENT, KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
      }
      val up = Intent(Intent.ACTION_MEDIA_BUTTON).apply {
        putExtra(Intent.EXTRA_KEY_EVENT, KeyEvent(KeyEvent.ACTION_UP, keyCode))
      }
      context.sendOrderedBroadcast(down, null)
      context.sendOrderedBroadcast(up, null)
      true
    }.getOrDefault(false)
  }

  fun mediaPlayPause(): Boolean = sendMediaKeyEvent(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
  fun mediaNext(): Boolean = sendMediaKeyEvent(KeyEvent.KEYCODE_MEDIA_NEXT)
  fun mediaPrevious(): Boolean = sendMediaKeyEvent(KeyEvent.KEYCODE_MEDIA_PREVIOUS)
}
