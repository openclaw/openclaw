package ai.openclaw.wear.complication

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.LongTextComplicationData
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.MonochromaticImageComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import ai.openclaw.wear.R
import ai.openclaw.wear.WearMainActivity
import ai.openclaw.wear.gateway.WearGatewayConfigStore
import ai.openclaw.wear.gateway.WearReplyAction

class TalkComplicationService : SuspendingComplicationDataSourceService() {

  override fun getPreviewData(type: ComplicationType): ComplicationData? {
    val icon = MonochromaticImage.Builder(
      Icon.createWithResource(this, R.drawable.ic_mic_complication),
    ).build()
    val text = PlainComplicationText.Builder(getString(R.string.wear_complication_talk_label)).build()

    return when (type) {
      ComplicationType.SHORT_TEXT ->
        ShortTextComplicationData.Builder(text, text)
          .setMonochromaticImage(icon)
          .build()

      ComplicationType.LONG_TEXT ->
        LongTextComplicationData.Builder(text, text)
          .setMonochromaticImage(icon)
          .build()

      ComplicationType.MONOCHROMATIC_IMAGE ->
        MonochromaticImageComplicationData.Builder(icon, text)
          .build()

      else -> null
    }
  }

  override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
    val config = WearGatewayConfigStore(this).load()
    val action = config.defaultReplyAction
    val tapIntent = Intent(this, WearMainActivity::class.java).apply {
      putExtra(WearMainActivity.EXTRA_LAUNCH_ACTION, action.storageValue)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      tapIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val icon = MonochromaticImage.Builder(
      Icon.createWithResource(this, R.drawable.ic_mic_complication),
    ).build()
    val shortText = PlainComplicationText.Builder(
      if (action == WearReplyAction.VOICE) {
        getString(R.string.wear_complication_talk_label)
      } else {
        getString(R.string.wear_complication_reply_label)
      },
    ).build()
    val longText = PlainComplicationText.Builder(
      if (config.usePhoneProxy) {
        if (action == WearReplyAction.VOICE) {
          getString(R.string.wear_complication_talk_via_phone)
        } else {
          getString(R.string.wear_complication_reply_via_phone)
        }
      } else {
        if (action == WearReplyAction.VOICE) {
          getString(R.string.wear_complication_talk_on_watch)
        } else {
          getString(R.string.wear_complication_reply_on_watch)
        }
      },
    ).build()

    return when (request.complicationType) {
      ComplicationType.SHORT_TEXT ->
        ShortTextComplicationData.Builder(shortText, shortText)
          .setMonochromaticImage(icon)
          .setTapAction(pendingIntent)
          .build()

      ComplicationType.LONG_TEXT ->
        LongTextComplicationData.Builder(longText, longText)
          .setMonochromaticImage(icon)
          .setTapAction(pendingIntent)
          .build()

      ComplicationType.MONOCHROMATIC_IMAGE ->
        MonochromaticImageComplicationData.Builder(icon, longText)
          .setTapAction(pendingIntent)
          .build()

      else -> null
    }
  }
}
