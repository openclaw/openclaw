package ai.openclaw.wear.tile

import android.content.Context
import androidx.wear.protolayout.DimensionBuilders
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.material3.ButtonColors
import androidx.wear.protolayout.material3.MaterialScope
import androidx.wear.protolayout.material3.Typography
import androidx.wear.protolayout.material3.button
import androidx.wear.protolayout.material3.icon
import androidx.wear.protolayout.material3.materialScope
import androidx.wear.protolayout.material3.primaryLayout
import androidx.wear.protolayout.material3.text
import androidx.wear.protolayout.material3.textEdgeButton
import androidx.wear.protolayout.types.LayoutColor
import androidx.wear.protolayout.types.LayoutString
import androidx.wear.tiles.Material3TileService
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.tooling.preview.TilePreviewData
import androidx.wear.tiles.tooling.preview.TilePreviewHelper
import androidx.wear.tooling.preview.devices.WearDevices
import ai.openclaw.wear.R
import ai.openclaw.wear.WearMainActivity
import ai.openclaw.wear.gateway.WearReplyAction

private const val TALK_CLICKABLE_ID = "talk"
private const val OPEN_CLICKABLE_ID = "open"
private const val PREVIEW_RESOURCES_VERSION = "talk-tile-preview"
private const val MIC_ICON_RESOURCE_ID = "talk_tile_mic"
private const val TALK_ICON_SIZE_DP = 32f

private val TALK_BUTTON_COLORS =
  ButtonColors(
    containerColor = LayoutColor(0xFFDD1A08.toInt()),
    iconColor = LayoutColor(0xFFFFFFFF.toInt()),
    labelColor = LayoutColor(0xFFFFFFFF.toInt()),
    secondaryLabelColor = LayoutColor(0xFFFFFFFF.toInt()),
  )

private val OPEN_BUTTON_COLORS =
  ButtonColors(
    containerColor = LayoutColor(0xFF851005.toInt()),
    iconColor = LayoutColor(0xFFFFFFFF.toInt()),
    labelColor = LayoutColor(0xFFFFFFFF.toInt()),
    secondaryLabelColor = LayoutColor(0xFFFFFFFF.toInt()),
  )

class TalkTileService : Material3TileService() {
  override suspend fun MaterialScope.tileResponse(
    requestParams: RequestBuilders.TileRequest,
  ): TileBuilders.Tile =
    TilePreviewHelper.singleTimelineEntryTileBuilder(
      buildTalkTileRoot(this@TalkTileService),
    ).build()
}

@androidx.wear.tiles.tooling.preview.Preview(
  device = WearDevices.LARGE_ROUND,
  fontScale = 1.3f,
)
@androidx.wear.tiles.tooling.preview.Preview(
  device = WearDevices.SMALL_ROUND,
  fontScale = 1.0f,
)
fun talkTilePreview(context: Context) =
  TilePreviewData(
    onTileResourceRequest = {
      ResourceBuilders.Resources.Builder()
        .setVersion(PREVIEW_RESOURCES_VERSION)
        .addIdToImageMapping(MIC_ICON_RESOURCE_ID, micIconResource())
        .build()
    },
    onTileRequest = { request ->
      TilePreviewHelper.singleTimelineEntryTileBuilder(
        buildTalkTileRoot(
          context = context,
          requestParams = request,
          usePreviewResourceIds = true,
        ),
      )
        .setResourcesVersion(PREVIEW_RESOURCES_VERSION)
        .build()
    },
  )

private fun buildTalkTileRoot(
  context: Context,
  requestParams: RequestBuilders.TileRequest,
  usePreviewResourceIds: Boolean = false,
): LayoutElementBuilders.LayoutElement =
  materialScope(
    context = context,
    deviceConfiguration = requestParams.deviceConfiguration,
  ) {
    buildTalkTileRoot(
      context = context,
      usePreviewResourceIds = usePreviewResourceIds,
    )
  }

private fun MaterialScope.buildTalkTileRoot(
  context: Context,
  usePreviewResourceIds: Boolean = false,
): LayoutElementBuilders.LayoutElement {
  val talkClickable =
    buildTalkTileClickable(
      packageName = context.packageName,
      id = TALK_CLICKABLE_ID,
      launchVoice = true,
    )
  val openClickable =
    buildTalkTileClickable(
      packageName = context.packageName,
      id = OPEN_CLICKABLE_ID,
      launchVoice = false,
    )

  return primaryLayout(
    titleSlot = {
      text(text = LayoutString(context.getString(R.string.app_name)))
    },
    mainSlot = {
      button(
        onClick = talkClickable,
        labelContent = {
          text(
            text = LayoutString(context.getString(R.string.wear_tile_talk_label)),
            typography = Typography.DISPLAY_SMALL,
            color = LayoutColor(0xFFFFFFFF.toInt()),
            maxLines = 1,
          )
        },
        iconContent = {
          buildMicIcon(
            contentDescription = context.getString(R.string.wear_tile_talk_label),
            usePreviewResourceIds = usePreviewResourceIds,
          )
        },
        width = expanded(),
        height = expanded(),
        colors = TALK_BUTTON_COLORS,
      )
    },
    bottomSlot = {
      textEdgeButton(
        onClick = openClickable,
        colors = OPEN_BUTTON_COLORS,
        labelContent = {
          text(text = LayoutString(context.getString(R.string.wear_tile_open_label)))
        },
      )
    },
  )
}

private fun buildTalkTileClickable(
  packageName: String,
  id: String,
  launchVoice: Boolean,
): ModifiersBuilders.Clickable {
  val activityBuilder =
    androidx.wear.protolayout.ActionBuilders.AndroidActivity.Builder()
      .setPackageName(packageName)
      .setClassName(WearMainActivity::class.java.name)

  if (launchVoice) {
    activityBuilder.addKeyToExtraMapping(
      WearMainActivity.EXTRA_LAUNCH_ACTION,
      androidx.wear.protolayout.ActionBuilders.AndroidStringExtra.Builder()
        .setValue(WearReplyAction.VOICE.storageValue)
        .build(),
    )
  }

  return ModifiersBuilders.Clickable.Builder()
    .setId(id)
    .setOnClick(
      androidx.wear.protolayout.ActionBuilders.LaunchAction.Builder()
        .setAndroidActivity(activityBuilder.build())
        .build(),
    )
    .build()
}

private fun expanded(): DimensionBuilders.ContainerDimension =
  DimensionBuilders.ExpandedDimensionProp.Builder().build()

private fun dp(value: Float): DimensionBuilders.DpProp =
  DimensionBuilders.DpProp.Builder(value).build()

private fun micIconResource(): ResourceBuilders.ImageResource =
  ResourceBuilders.ImageResource.Builder()
    .setAndroidResourceByResId(
      ResourceBuilders.AndroidImageResourceByResId.Builder()
        .setResourceId(R.drawable.ic_mic_tile)
        .build(),
    )
    .build()

@Suppress("DEPRECATION")
private fun MaterialScope.buildMicIcon(
  contentDescription: String,
  usePreviewResourceIds: Boolean,
): LayoutElementBuilders.LayoutElement =
  if (usePreviewResourceIds) {
    icon(
      MIC_ICON_RESOURCE_ID,
      dp(TALK_ICON_SIZE_DP),
      dp(TALK_ICON_SIZE_DP),
      LayoutColor(0xFFFFFFFF.toInt()),
    )
  } else {
    icon(
      micIconResource(),
      contentDescription,
      dp(TALK_ICON_SIZE_DP),
      dp(TALK_ICON_SIZE_DP),
      LayoutColor(0xFFFFFFFF.toInt()),
    )
  }
