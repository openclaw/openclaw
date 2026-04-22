package ai.openclaw.app.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.openclaw.app.chat.ChatModelCatalogEntry
import ai.openclaw.app.chat.ChatSessionDefaults
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.ui.mobileAccent
import ai.openclaw.app.ui.mobileAccentBorderStrong
import ai.openclaw.app.ui.mobileAccentSoft
import ai.openclaw.app.ui.mobileBorder
import ai.openclaw.app.ui.mobileBorderStrong
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCaption1
import ai.openclaw.app.ui.mobileCardSurface
import ai.openclaw.app.ui.mobileHeadline
import ai.openclaw.app.ui.mobileSurface
import ai.openclaw.app.ui.mobileText
import ai.openclaw.app.ui.mobileTextSecondary
import ai.openclaw.app.ui.mobileTextTertiary

internal data class DraftApplication(
  val input: String,
  val lastAppliedDraft: String?,
  val consumed: Boolean,
)

internal data class SelectOption(
  val value: String,
  val label: String,
)

internal fun applyDraftText(
  draftText: String?,
  currentInput: String,
  lastAppliedDraft: String?,
): DraftApplication {
  val draft =
    draftText?.trim()?.ifEmpty { null } ?: return DraftApplication(
      input = currentInput,
      lastAppliedDraft = null,
      consumed = false,
    )
  if (draft == lastAppliedDraft) {
    return DraftApplication(
      input = currentInput,
      lastAppliedDraft = lastAppliedDraft,
      consumed = false,
    )
  }
  return DraftApplication(
    input = draft,
    lastAppliedDraft = draft,
    consumed = true,
  )
}

@Composable
fun ChatComposer(
  draftText: String?,
  healthOk: Boolean,
  thinkingLevel: String,
  pendingRunCount: Int,
  attachments: List<PendingImageAttachment>,
  activeSession: ChatSessionEntry?,
  sessionDefaults: ChatSessionDefaults,
  modelCatalog: List<ChatModelCatalogEntry>,
  onDraftApplied: () -> Unit,
  onPickImages: () -> Unit,
  onRemoveAttachment: (id: String) -> Unit,
  onSetThinkingLevel: (level: String) -> Unit,
  onSetModel: (model: String?) -> Unit,
  onRefresh: () -> Unit,
  onAbort: () -> Unit,
  onSend: (text: String) -> Unit,
  footerContent: (@Composable () -> Unit)? = null,
) {
  var input by rememberSaveable { mutableStateOf("") }
  var lastAppliedDraft by rememberSaveable { mutableStateOf<String?>(null) }
  var showThinkingMenu by remember { mutableStateOf(false) }
  var showModelMenu by remember { mutableStateOf(false) }
  var showAdvancedControls by rememberSaveable { mutableStateOf(false) }

  LaunchedEffect(draftText) {
    val next = applyDraftText(draftText = draftText, currentInput = input, lastAppliedDraft = lastAppliedDraft)
    input = next.input
    lastAppliedDraft = next.lastAppliedDraft
    if (next.consumed) {
      onDraftApplied()
    }
  }

  val canSend = pendingRunCount == 0 && (input.trim().isNotEmpty() || attachments.isNotEmpty()) && healthOk
  val sendBusy = pendingRunCount > 0
  val pickersEnabled = pendingRunCount == 0
  val normalizedThinking = normalizeThinkingLevelForUi(thinkingLevel)
  val currentModelValue = resolveCurrentModelValue(activeSession)
  val defaultModelValue = resolveDefaultModelValue(sessionDefaults)
  val defaultModelLabel =
    if (defaultModelValue.isBlank()) {
      "Default model"
    } else {
      "Default (${formatModelLabel(defaultModelValue, modelCatalog)})"
    }
  val selectedModelLabel =
    if (currentModelValue.isBlank()) defaultModelLabel else formatModelLabel(currentModelValue, modelCatalog)
  val thinkingOptions =
    remember(activeSession?.modelProvider, currentModelValue, normalizedThinking) {
      buildThinkingOptionsForProvider(
        provider = activeSession?.modelProvider ?: sessionDefaults.modelProvider,
        currentValue = normalizedThinking,
      )
    }
  val thinkingButtonLabel = thinkingMenuLabel(normalizedThinking, activeSession, sessionDefaults, modelCatalog)
  val modelOptions =
    remember(modelCatalog, currentModelValue, defaultModelValue) {
      buildModelOptions(modelCatalog = modelCatalog, currentValue = currentModelValue, defaultValue = defaultModelValue)
    }

  Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    if (attachments.isNotEmpty()) {
      AttachmentsStrip(attachments = attachments, onRemoveAttachment = onRemoveAttachment)
    }

    if (!healthOk) {
      Text(
        text = "Gateway is offline. Connect first in the Connect tab.",
        style = mobileCallout,
        color = ai.openclaw.app.ui.mobileWarning,
      )
    }

    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.Bottom,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      OutlinedTextField(
        value = input,
        onValueChange = { input = it },
        modifier = Modifier.weight(1f).heightIn(min = 104.dp),
        placeholder = { Text("Type a message…", style = mobileBodyStyle(), color = mobileTextTertiary) },
        minLines = 3,
        maxLines = if (showAdvancedControls) 5 else 6,
        textStyle = mobileBodyStyle().copy(color = mobileText),
        shape = RoundedCornerShape(14.dp),
        colors = chatTextFieldColors(),
      )

      Column(
        modifier = Modifier.heightIn(min = 104.dp),
        verticalArrangement = Arrangement.SpaceBetween,
        horizontalAlignment = Alignment.CenterHorizontally,
      ) {
        Button(
          onClick = {
            val text = input
            input = ""
            onSend(text)
          },
          enabled = canSend,
          modifier = Modifier.size(52.dp),
          shape = RoundedCornerShape(14.dp),
          contentPadding = PaddingValues(0.dp),
          colors =
            ButtonDefaults.buttonColors(
              containerColor = mobileAccent,
              contentColor = Color.White,
              disabledContainerColor = mobileBorderStrong,
              disabledContentColor = mobileTextTertiary,
            ),
          border = BorderStroke(1.dp, if (canSend) mobileAccentBorderStrong else mobileBorderStrong),
        ) {
          if (sendBusy) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = Color.White)
          } else {
            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send", modifier = Modifier.size(18.dp))
          }
        }
        IconOnlyActionButton(
          icon = if (showAdvancedControls) Icons.Default.Visibility else Icons.Default.VisibilityOff,
          contentDescription = if (showAdvancedControls) "Hide advanced chat controls" else "Show advanced chat controls",
          enabled = true,
          onClick = { showAdvancedControls = !showAdvancedControls },
        )
      }
    }

    AnimatedVisibility(visible = showAdvancedControls) {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          Box(modifier = Modifier.weight(1f)) {
            Surface(
              onClick = { if (pickersEnabled) showModelMenu = true },
              shape = RoundedCornerShape(14.dp),
              color = mobileCardSurface,
              border = BorderStroke(1.dp, mobileBorderStrong),
              modifier = Modifier.fillMaxWidth(),
            ) {
              Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
              ) {
                Text(
                  text = selectedModelLabel,
                  style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
                  color = if (pickersEnabled) mobileTextSecondary else mobileTextTertiary,
                  maxLines = 1,
                  overflow = TextOverflow.Ellipsis,
                  modifier = Modifier.weight(1f),
                )
                Icon(
                  Icons.Default.ArrowDropDown,
                  contentDescription = "Select chat model",
                  modifier = Modifier.size(18.dp),
                  tint = if (pickersEnabled) mobileTextTertiary else mobileBorderStrong,
                )
              }
            }

            DropdownMenu(
              expanded = showModelMenu,
              onDismissRequest = { showModelMenu = false },
              shape = RoundedCornerShape(16.dp),
              containerColor = mobileCardSurface,
              tonalElevation = 0.dp,
              shadowElevation = 8.dp,
              border = BorderStroke(1.dp, mobileBorder),
            ) {
              DropdownMenuItem(
                text = { Text(defaultModelLabel, style = mobileCallout, color = mobileText) },
                onClick = {
                  onSetModel(null)
                  showModelMenu = false
                },
                trailingIcon = {
                  if (currentModelValue.isBlank()) {
                    Text("✓", style = mobileCallout, color = mobileAccent)
                  }
                },
              )
              modelOptions.forEach { option ->
                DropdownMenuItem(
                  text = {
                    Text(
                      option.label,
                      style = mobileCallout,
                      color = mobileText,
                      maxLines = 1,
                      overflow = TextOverflow.Ellipsis,
                    )
                  },
                  onClick = {
                    onSetModel(option.value)
                    showModelMenu = false
                  },
                  trailingIcon = {
                    if (option.value == currentModelValue) {
                      Text("✓", style = mobileCallout, color = mobileAccent)
                    }
                  },
                )
              }
            }
          }

          Box(modifier = Modifier.weight(1f)) {
            Surface(
              onClick = { if (pickersEnabled) showThinkingMenu = true },
              shape = RoundedCornerShape(14.dp),
              color = mobileCardSurface,
              border = BorderStroke(1.dp, mobileBorderStrong),
              modifier = Modifier.fillMaxWidth(),
            ) {
              Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
              ) {
                Text(
                  text = thinkingButtonLabel,
                  style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
                  color = if (pickersEnabled) mobileTextSecondary else mobileTextTertiary,
                  maxLines = 1,
                  overflow = TextOverflow.Ellipsis,
                  modifier = Modifier.weight(1f),
                )
                Icon(
                  Icons.Default.ArrowDropDown,
                  contentDescription = "Select thinking level",
                  modifier = Modifier.size(18.dp),
                  tint = if (pickersEnabled) mobileTextTertiary else mobileBorderStrong,
                )
              }
            }

            DropdownMenu(
              expanded = showThinkingMenu,
              onDismissRequest = { showThinkingMenu = false },
              shape = RoundedCornerShape(16.dp),
              containerColor = mobileCardSurface,
              tonalElevation = 0.dp,
              shadowElevation = 8.dp,
              border = BorderStroke(1.dp, mobileBorder),
            ) {
              ThinkingMenuItem(
                value = "",
                label = thinkingDefaultLabel(activeSession, sessionDefaults, modelCatalog),
                current = normalizedThinking,
                onSet = onSetThinkingLevel,
              ) { showThinkingMenu = false }
              thinkingOptions.forEach { option ->
                ThinkingMenuItem(
                  value = option.value,
                  label = option.label,
                  current = normalizedThinking,
                  onSet = onSetThinkingLevel,
                ) { showThinkingMenu = false }
              }
            }
          }
        }

        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          SecondaryActionButton(
            label = "Attach",
            icon = Icons.Default.AttachFile,
            enabled = true,
            compact = true,
            onClick = onPickImages,
          )

          SecondaryActionButton(
            label = "Refresh",
            icon = Icons.Default.Refresh,
            enabled = true,
            compact = true,
            onClick = onRefresh,
          )

          SecondaryActionButton(
            label = "Abort",
            icon = Icons.Default.Stop,
            enabled = pendingRunCount > 0,
            compact = true,
            onClick = onAbort,
          )
        }

        footerContent?.invoke()
      }
    }
  }
}

@Composable
private fun IconOnlyActionButton(
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  contentDescription: String,
  enabled: Boolean,
  onClick: () -> Unit,
) {
  Button(
    onClick = onClick,
    enabled = enabled,
    modifier = Modifier.size(44.dp),
    shape = RoundedCornerShape(14.dp),
    colors =
      ButtonDefaults.buttonColors(
        containerColor = mobileCardSurface,
        contentColor = mobileTextSecondary,
        disabledContainerColor = mobileCardSurface,
        disabledContentColor = mobileTextTertiary,
      ),
    border = BorderStroke(1.dp, mobileBorderStrong),
    contentPadding = PaddingValues(0.dp),
  ) {
    Icon(icon, contentDescription = contentDescription, modifier = Modifier.size(18.dp))
  }
}

@Composable
private fun SecondaryActionButton(
  label: String,
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  enabled: Boolean,
  compact: Boolean = false,
  onClick: () -> Unit,
) {
  Button(
    onClick = onClick,
    enabled = enabled,
    modifier = if (compact) Modifier.size(44.dp) else Modifier.height(44.dp),
    shape = RoundedCornerShape(14.dp),
    colors =
      ButtonDefaults.buttonColors(
        containerColor = mobileCardSurface,
        contentColor = mobileTextSecondary,
        disabledContainerColor = mobileCardSurface,
        disabledContentColor = mobileTextTertiary,
      ),
    border = BorderStroke(1.dp, mobileBorderStrong),
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
  label: String,
  current: String,
  onSet: (String) -> Unit,
  onDismiss: () -> Unit,
) {
  DropdownMenuItem(
    text = { Text(label, style = mobileCallout, color = mobileText) },
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

internal fun normalizeThinkingLevelForUi(raw: String?): String {
  val key = raw?.trim()?.lowercase().orEmpty()
  val collapsed = key.replace(Regex("[\\s_-]+"), "")
  return when {
    key.isBlank() || key == "default" -> ""
    key == "off" -> "off"
    key == "on" || key == "enable" || key == "enabled" -> "low"
    key == "min" || key == "minimal" || key == "think" -> "minimal"
    key == "low" || key == "thinkhard" -> "low"
    key == "medium" || key == "med" || key == "mid" || key == "harder" || key == "thinkharder" -> "medium"
    key == "high" || key == "max" || key == "highest" || key == "thinkhardest" || key == "ultra" || key == "ultrathink" -> "high"
    collapsed == "adaptive" || collapsed == "auto" -> "adaptive"
    collapsed == "xhigh" || collapsed == "extrahigh" -> "xhigh"
    else -> key
  }
}

internal fun thinkingLabel(raw: String): String {
  return when (normalizeThinkingLevelForUi(raw)) {
    "minimal" -> "Minimal"
    "low" -> "Low"
    "medium" -> "Medium"
    "high" -> "High"
    "adaptive" -> "Adaptive"
    "xhigh" -> "Extra high"
    "off" -> "Off"
    else -> "Default"
  }
}

internal fun resolveCurrentModelValue(activeSession: ChatSessionEntry?): String {
  val model = activeSession?.model?.trim().orEmpty()
  if (model.isEmpty()) return ""
  val provider = activeSession?.modelProvider?.trim().orEmpty()
  return if (provider.isNotEmpty() && !model.startsWith("$provider/")) "$provider/$model" else model
}

internal fun resolveDefaultModelValue(defaults: ChatSessionDefaults): String {
  val model = defaults.model?.trim().orEmpty()
  if (model.isEmpty()) return ""
  val provider = defaults.modelProvider?.trim().orEmpty()
  return if (provider.isNotEmpty() && !model.startsWith("$provider/")) "$provider/$model" else model
}

internal fun formatModelLabel(value: String, catalog: List<ChatModelCatalogEntry>): String {
  val trimmed = value.trim()
  if (trimmed.isEmpty()) return ""
  val hit = catalog.firstOrNull { optionValue(it).equals(trimmed, ignoreCase = true) }
  if (hit != null) {
    return hit.alias?.trim()?.takeIf { it.isNotEmpty() }
      ?: hit.name.trim().ifEmpty { "${hit.id} · ${hit.provider}" }
  }
  val slash = trimmed.indexOf('/')
  return if (slash > 0) "${trimmed.substring(slash + 1)} · ${trimmed.substring(0, slash)}" else trimmed
}

internal fun buildModelOptions(
  modelCatalog: List<ChatModelCatalogEntry>,
  currentValue: String,
  defaultValue: String,
): List<SelectOption> {
  val seen = LinkedHashSet<String>()
  val result = mutableListOf<SelectOption>()

  fun add(value: String) {
    val trimmed = value.trim()
    if (trimmed.isEmpty()) return
    val key = trimmed.lowercase()
    if (!seen.add(key)) return
    result += SelectOption(trimmed, formatModelLabel(trimmed, modelCatalog))
  }

  modelCatalog.forEach { add(optionValue(it)) }
  add(currentValue)
  add(defaultValue)
  return result
}

internal fun buildThinkingOptionsForProvider(
  provider: String?,
  currentValue: String,
): List<SelectOption> {
  val normalizedProvider = provider?.trim()?.lowercase().orEmpty()
  val base = if (normalizedProvider == "zai" || normalizedProvider == "z-ai") listOf("off", "on") else listOf("off", "minimal", "low", "medium", "high", "adaptive")
  val values = LinkedHashSet<String>()
  values.addAll(base)
  if (currentValue.isNotBlank()) values.add(currentValue)
  return values
    .filter { it.isNotBlank() }
    .map { SelectOption(it, thinkingLabel(it)) }
}

internal fun thinkingDefaultLabel(
  activeSession: ChatSessionEntry?,
  sessionDefaults: ChatSessionDefaults,
  modelCatalog: List<ChatModelCatalogEntry>,
): String {
  val provider = activeSession?.modelProvider ?: sessionDefaults.modelProvider
  val model = resolveCurrentModelValue(activeSession).ifBlank { resolveDefaultModelValue(sessionDefaults) }
  val defaultLevel = resolveThinkingDefault(provider, model, modelCatalog)
  return "Default (${thinkingLabel(defaultLevel)})"
}

internal fun thinkingMenuLabel(
  currentThinking: String,
  activeSession: ChatSessionEntry?,
  sessionDefaults: ChatSessionDefaults,
  modelCatalog: List<ChatModelCatalogEntry>,
): String {
  return if (currentThinking.isBlank()) thinkingDefaultLabel(activeSession, sessionDefaults, modelCatalog) else "Think: ${thinkingLabel(currentThinking)}"
}

private fun resolveThinkingDefault(
  provider: String?,
  model: String,
  catalog: List<ChatModelCatalogEntry>,
): String {
  val normalizedProvider = provider?.trim()?.lowercase().orEmpty()
  val modelId = model.substringAfter('/').trim().ifEmpty { model.trim() }
  if (normalizedProvider == "anthropic" && Regex("^claude-(?:opus|sonnet)-4(?:\\.|-)6(?:$|[-.])", RegexOption.IGNORE_CASE).containsMatchIn(modelId)) {
    return "adaptive"
  }
  if ((normalizedProvider == "amazon-bedrock" || normalizedProvider == "bedrock") && Regex("claude-(?:opus|sonnet)-4(?:\\.|-)6(?:$|[-.])", RegexOption.IGNORE_CASE).containsMatchIn(modelId)) {
    return "adaptive"
  }
  val hit = catalog.firstOrNull { optionValue(it).equals(model, ignoreCase = true) }
  return if (hit?.reasoning == true) "low" else "off"
}

private fun optionValue(entry: ChatModelCatalogEntry): String {
  return "${entry.provider.trim()}/${entry.id.trim()}".trim('/')
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
        color = mobileCardSurface,
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
    unfocusedBorderColor = mobileBorder,
    focusedTextColor = mobileText,
    unfocusedTextColor = mobileText,
    cursorColor = mobileAccent,
  )

@Composable
private fun mobileBodyStyle() =
  MaterialTheme.typography.bodyMedium.copy(
    fontFamily = ai.openclaw.app.ui.mobileFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 15.sp,
    lineHeight = 22.sp,
  )
