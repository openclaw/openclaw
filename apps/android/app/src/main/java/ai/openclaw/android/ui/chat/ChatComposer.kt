package ai.openclaw.android.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.window.PopupProperties
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.openclaw.android.ui.mobileAccent
import ai.openclaw.android.ui.mobileAccentSoft
import ai.openclaw.android.ui.mobileBorder
import ai.openclaw.android.ui.mobileBorderStrong
import ai.openclaw.android.ui.mobileCallout
import ai.openclaw.android.ui.mobileCaption1
import ai.openclaw.android.ui.mobileHeadline
import ai.openclaw.android.ui.mobileSurface
import ai.openclaw.android.ui.mobileSurfaceStrong
import ai.openclaw.android.ui.mobileText
import ai.openclaw.android.ui.mobileTextSecondary
import ai.openclaw.android.ui.mobileTextTertiary

@Composable
fun ChatComposer(
  healthOk: Boolean,
  thinkingLevel: String,
  pendingRunCount: Int,
  queuedCount: Int,
  errorText: String?,
  attachments: List<PendingImageAttachment>,
  onPickImages: () -> Unit,
  onRemoveAttachment: (id: String) -> Unit,
  onSetThinkingLevel: (level: String) -> Unit,
  onRefresh: () -> Unit,
  onAbort: () -> Unit,
  onRetryLast: () -> Unit,
  onSend: (text: String, reEvaluateOnReconnect: Boolean) -> Unit,
) {
  var input by rememberSaveable { mutableStateOf("") }
  var showThinkingMenu by remember { mutableStateOf(false) }
  var reEvaluateOnReconnect by rememberSaveable { mutableStateOf(true) }
  var showTimeCapsuleDetails by rememberSaveable { mutableStateOf(false) }

  val canSend = pendingRunCount == 0 && (input.trim().isNotEmpty() || attachments.isNotEmpty())
  val sendBusy = pendingRunCount > 0
  val canRetryLast = !errorText.isNullOrBlank() && pendingRunCount == 0
  val imeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
  var showActionsMenu by remember { mutableStateOf(false) }
  val compactMode = imeVisible || showActionsMenu
  val sendAlpha by animateFloatAsState(
    targetValue = if (canSend) 1f else 0.75f,
    animationSpec = tween(durationMillis = 100),
    label = "sendAlpha",
  )

  Column(
    modifier = Modifier.fillMaxWidth().animateContentSize(),
    verticalArrangement = Arrangement.spacedBy(if (compactMode) 6.dp else 8.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Box(modifier = Modifier.weight(1f)) {
        Surface(
          onClick = { showThinkingMenu = true },
          shape = RoundedCornerShape(16.dp),
          color = mobileAccentSoft,
          border = BorderStroke(1.dp, mobileBorderStrong),
        ) {
          Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
          ) {
            Text(
              text = "Thinking: ${thinkingLabel(thinkingLevel)}",
              style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
              color = mobileText,
            )
            Icon(Icons.Default.ArrowDropDown, contentDescription = "Select thinking level", tint = mobileTextSecondary)
          }
        }

        DropdownMenu(
          expanded = showThinkingMenu,
          onDismissRequest = { showThinkingMenu = false },
          containerColor = mobileSurfaceStrong,
        ) {
          ThinkingMenuItem("off", thinkingLevel, onSetThinkingLevel) { showThinkingMenu = false }
          ThinkingMenuItem("low", thinkingLevel, onSetThinkingLevel) { showThinkingMenu = false }
          ThinkingMenuItem("medium", thinkingLevel, onSetThinkingLevel) { showThinkingMenu = false }
          ThinkingMenuItem("high", thinkingLevel, onSetThinkingLevel) { showThinkingMenu = false }
        }
      }

      SecondaryActionButton(
        label = "Attach",
        icon = Icons.Default.AttachFile,
        enabled = true,
        compact = compactMode,
        containerColor = mobileSurfaceStrong,
        borderColor = mobileBorderStrong,
        textColor = mobileText,
        onClick = onPickImages,
      )
    }

    AnimatedVisibility(
      visible = attachments.isNotEmpty(),
      enter = fadeIn(animationSpec = tween(90)),
      exit = fadeOut(animationSpec = tween(90)),
    ) {
      AttachmentsStrip(attachments = attachments, onRemoveAttachment = onRemoveAttachment)
    }

    HorizontalDivider(color = mobileBorder)


    OutlinedTextField(
      value = input,
      onValueChange = { input = it },
      modifier = Modifier.fillMaxWidth().height(if (compactMode) 68.dp else 82.dp),
      placeholder = { Text("Type a message", style = mobileBodyStyle(), color = mobileTextTertiary) },
      minLines = if (compactMode) 1 else 2,
      maxLines = if (compactMode) 4 else 5,
      textStyle = mobileBodyStyle().copy(color = mobileText),
      shape = RoundedCornerShape(16.dp),
      colors = chatTextFieldColors(),
    )

    AnimatedVisibility(
      visible = !healthOk,
      enter = fadeIn(animationSpec = tween(90)),
      exit = fadeOut(animationSpec = tween(90)),
    ) {
      Text(
        text = "Dead Zone mode: messages queue locally and auto-send on reconnect.",
        style = mobileCallout,
        color = ai.openclaw.android.ui.mobileWarning,
      )
    }

    AnimatedVisibility(
      visible = queuedCount > 0,
      enter = fadeIn(animationSpec = tween(90)),
      exit = fadeOut(animationSpec = tween(90)),
    ) {
      Text(
        text = "Queued offline: $queuedCount",
        style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
        color = ai.openclaw.android.ui.mobileWarning,
      )
    }

    if (!compactMode && showTimeCapsuleDetails) {
      Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = mobileAccentSoft,
        border = BorderStroke(1.dp, mobileBorder),
        onClick = { showTimeCapsuleDetails = false },
      ) {
        Text(
          text =
            if (reEvaluateOnReconnect) {
              "Re-evaluate queued messages before send"
            } else {
              "Send queued messages as-written"
            },
          style = mobileCaption1,
          color = mobileText,
          modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
        )
      }
    }

    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Surface(
        onClick = {
          reEvaluateOnReconnect = !reEvaluateOnReconnect
          showTimeCapsuleDetails = !compactMode
        },
        modifier = Modifier.size(44.dp),
        shape = RoundedCornerShape(16.dp),
        color = if (reEvaluateOnReconnect) mobileAccentSoft else mobileSurfaceStrong,
        border = BorderStroke(1.dp, if (reEvaluateOnReconnect) mobileAccent else mobileBorderStrong),
      ) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          Text(
            text = "TC",
            style = mobileCaption1.copy(fontWeight = FontWeight.Bold),
            color = if (reEvaluateOnReconnect) mobileAccent else mobileTextSecondary,
          )
        }
      }

      Box {
        SecondaryActionButton(
          label = "Actions",
          icon = Icons.Default.MoreVert,
          enabled = true,
          compact = true,
          containerColor = mobileSurfaceStrong,
          borderColor = mobileBorderStrong,
          textColor = mobileText,
          onClick = { showActionsMenu = true },
        )
        DropdownMenu(
          expanded = showActionsMenu,
          onDismissRequest = { showActionsMenu = false },
          properties = PopupProperties(focusable = false),
        ) {
          DropdownMenuItem(
            text = { Text("Refresh") },
            onClick = {
              showActionsMenu = false
              onRefresh()
            },
          )
          DropdownMenuItem(
            text = { Text("Abort") },
            enabled = pendingRunCount > 0,
            onClick = {
              showActionsMenu = false
              onAbort()
            },
          )
          DropdownMenuItem(
            text = { Text("Retry") },
            enabled = canRetryLast,
            onClick = {
              showActionsMenu = false
              onRetryLast()
            },
          )
        }
      }

      Button(
        onClick = {
          val text = input
          input = ""
          onSend(text, reEvaluateOnReconnect)
        },
        enabled = canSend,
        modifier = Modifier.weight(1f).height(48.dp).graphicsLayer { alpha = sendAlpha },
        shape = RoundedCornerShape(16.dp),
        colors =
          ButtonDefaults.buttonColors(
            containerColor = mobileAccent,
            contentColor = Color.White,
            disabledContainerColor = mobileBorderStrong,
            disabledContentColor = mobileTextTertiary,
          ),
        border = BorderStroke(1.dp, if (canSend) Color(0xFF154CAD) else mobileBorderStrong),
      ) {
        if (sendBusy) {
          CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = Color.White)
        } else {
          Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null, modifier = Modifier.size(16.dp))
        }
        Spacer(modifier = Modifier.width(8.dp))
        Text(
          text = if (healthOk) "Send" else "Queue",
          style = mobileHeadline.copy(fontWeight = FontWeight.Bold),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
  }
}

@Composable
private fun SecondaryActionButton(
  label: String,
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  enabled: Boolean,
  compact: Boolean = false,
  containerColor: Color = Color.White,
  borderColor: Color = mobileBorderStrong,
  textColor: Color = mobileTextSecondary,
  onClick: () -> Unit,
) {
  Button(
    onClick = onClick,
    enabled = enabled,
    modifier = if (compact) Modifier.size(44.dp) else Modifier.height(44.dp),
    shape = RoundedCornerShape(16.dp),
    colors =
      ButtonDefaults.buttonColors(
        containerColor = containerColor,
        contentColor = textColor,
        disabledContainerColor = containerColor,
        disabledContentColor = mobileTextTertiary,
      ),
    border = BorderStroke(1.dp, borderColor),
    contentPadding = if (compact) PaddingValues(0.dp) else ButtonDefaults.ContentPadding,
  ) {
    Icon(icon, contentDescription = label, modifier = Modifier.size(14.dp))
    if (!compact) {
      Spacer(modifier = Modifier.width(5.dp))
      Text(
        text = label,
        style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
        color = if (enabled) mobileTextSecondary else mobileTextTertiary,
      )
    }
  }
}

@Composable
private fun ThinkingMenuItem(
  value: String,
  current: String,
  onSet: (String) -> Unit,
  onDismiss: () -> Unit,
) {
  DropdownMenuItem(
    colors =
      androidx.compose.material3.MenuDefaults.itemColors(
        textColor = mobileText,
        leadingIconColor = mobileText,
        trailingIconColor = mobileAccent,
      ),
    text = { Text(thinkingLabel(value), style = mobileCallout, color = mobileText) },
    onClick = {
      onSet(value)
      onDismiss()
    },
    trailingIcon = {
      if (value == current.trim().lowercase()) {
        Text("✓", style = mobileCallout, color = mobileAccent)
      } else {
        Spacer(modifier = Modifier.width(10.dp))
      }
    },
  )
}

private fun thinkingLabel(raw: String): String {
  return when (raw.trim().lowercase()) {
    "low" -> "Low"
    "medium" -> "Medium"
    "high" -> "High"
    else -> "Off"
  }
}

@Composable
private fun AttachmentsStrip(
  attachments: List<PendingImageAttachment>,
  onRemoveAttachment: (id: String) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    for (att in attachments) {
      AttachmentChip(
        fileName = att.fileName,
        onRemove = { onRemoveAttachment(att.id) },
      )
    }
  }
}

@Composable
private fun AttachmentChip(fileName: String, onRemove: () -> Unit) {
  Surface(
    shape = RoundedCornerShape(999.dp),
    color = mobileAccentSoft,
    border = BorderStroke(1.dp, mobileBorderStrong),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(
        text = fileName,
        style = mobileCaption1,
        color = mobileText,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Surface(
        onClick = onRemove,
        shape = RoundedCornerShape(999.dp),
        color = Color.White,
        border = BorderStroke(1.dp, mobileBorderStrong),
      ) {
        Text(
          text = "×",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold),
          color = mobileTextSecondary,
          modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        )
      }
    }
  }
}

@Composable
private fun chatTextFieldColors() =
  OutlinedTextFieldDefaults.colors(
    focusedContainerColor = mobileSurface,
    unfocusedContainerColor = mobileSurface,
    focusedBorderColor = mobileAccent,
    unfocusedBorderColor = mobileBorder.copy(alpha = 0.78f),
    focusedTextColor = mobileText,
    unfocusedTextColor = mobileText,
    cursorColor = mobileAccent,
  )

@Composable
private fun mobileBodyStyle() =
  MaterialTheme.typography.bodyMedium.copy(
    fontFamily = ai.openclaw.android.ui.mobileFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 15.sp,
    lineHeight = 22.sp,
  )
