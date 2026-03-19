package ai.openclaw.app.ui.chat

import android.util.Log
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import ai.openclaw.app.ui.mobileAccent
import ai.openclaw.app.ui.mobileBorder
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCaption1
import ai.openclaw.app.ui.mobileCodeBg
import ai.openclaw.app.ui.mobileCodeBorder
import ai.openclaw.app.ui.mobileCodeText
import ai.openclaw.app.ui.mobileText
import ai.openclaw.app.ui.mobileTextSecondary

private const val TAG = "AdaptiveCard"

/**
 * Renders an Adaptive Card from a parsed JSON map inline in a chat bubble.
 * Supports TextBlock, FactSet, ColumnSet, Container, Image (placeholder),
 * Table, RichTextBlock, CodeBlock, ActionSet, ImageSet, Rating, ProgressBar,
 * Action.Submit, Action.Execute, and Action.OpenUrl.
 * Unknown element types are silently skipped.
 */
@Composable
fun AdaptiveCardView(card: Map<String, Any>, modifier: Modifier = Modifier) {
  Surface(
    shape = RoundedCornerShape(12.dp),
    border = BorderStroke(1.dp, mobileBorder),
    color = MaterialTheme.colorScheme.surface,
    modifier = modifier.fillMaxWidth(),
  ) {
    Column(
      modifier = Modifier.padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      // Render body elements
      val body = card.typedList("body")
      for (element in body) {
        RenderElement(element)
      }

      // Render actions
      val actions = card.typedList("actions")
      if (actions.isNotEmpty()) {
        Spacer(modifier = Modifier.height(4.dp))
        Row(
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          modifier = Modifier.fillMaxWidth(),
        ) {
          for (action in actions) {
            RenderAction(action, modifier = Modifier.weight(1f))
          }
        }
      }
    }
  }
}

// -- Element rendering --

@Composable
private fun RenderElement(element: Map<String, Any>) {
  when (element["type"] as? String) {
    "TextBlock" -> RenderTextBlock(element)
    "FactSet" -> RenderFactSet(element)
    "ColumnSet" -> RenderColumnSet(element)
    "Container" -> RenderContainer(element)
    "Image" -> RenderImagePlaceholder(element)
    "Table" -> RenderTable(element)
    "RichTextBlock" -> RenderRichTextBlock(element)
    "CodeBlock" -> RenderCodeBlock(element)
    "ActionSet" -> RenderActionSet(element)
    "ImageSet" -> RenderImageSet(element)
    "Rating" -> RenderRating(element)
    "ProgressBar" -> RenderProgressBar(element)
    else -> {
      // Skip unknown element types gracefully
      Log.d(TAG, "Skipping unknown element type: ${element["type"]}")
    }
  }
}

@Composable
private fun RenderTextBlock(element: Map<String, Any>) {
  val text = element["text"] as? String ?: return
  val size = element["size"] as? String
  val weight = element["weight"] as? String
  val isSubtle = element["isSubtle"] == true

  val style = when (size?.lowercase()) {
    "large" -> MaterialTheme.typography.titleMedium
    "small" -> mobileCaption1
    else -> mobileCallout
  }

  val fontWeight = when (weight?.lowercase()) {
    "bolder" -> FontWeight.Bold
    "lighter" -> FontWeight.Light
    else -> style.fontWeight
  }

  val color = if (isSubtle) mobileTextSecondary else mobileText

  Text(
    text = text,
    style = style.copy(fontWeight = fontWeight),
    color = color,
  )
}

@Composable
private fun RenderFactSet(element: Map<String, Any>) {
  val facts = element.typedList("facts")
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    for (fact in facts) {
      val title = fact["title"] as? String ?: continue
      val value = fact["value"] as? String ?: ""
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Text(
          text = title,
          style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
          color = mobileText,
          modifier = Modifier.weight(0.4f),
        )
        Text(
          text = value,
          style = mobileCallout,
          color = mobileTextSecondary,
          modifier = Modifier.weight(0.6f),
        )
      }
    }
  }
}

@Composable
private fun RenderColumnSet(element: Map<String, Any>) {
  val columns = element.typedList("columns")
  if (columns.isEmpty()) return

  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    for (column in columns) {
      val items = column.typedList("items")
      // Use width property for weight; default to equal distribution
      val widthStr = column["width"] as? String
      val weight = widthStr?.removeSuffix("px")?.toFloatOrNull()
        ?: if (widthStr == "stretch" || widthStr == "auto" || widthStr == null) 1f else 1f

      Column(
        modifier = Modifier.weight(weight),
        verticalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        for (item in items) {
          RenderElement(item)
        }
      }
    }
  }
}

@Composable
private fun RenderContainer(element: Map<String, Any>) {
  val items = element.typedList("items")
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    for (item in items) {
      RenderElement(item)
    }
  }
}

@Composable
private fun RenderImagePlaceholder(element: Map<String, Any>) {
  // TODO: Use Coil or Glide for actual image loading when available as a dependency.
  // For now, show alt text or URL as a placeholder.
  val altText = element["altText"] as? String
  val url = element["url"] as? String ?: ""
  Text(
    text = altText ?: "[Image: $url]",
    style = mobileCaption1,
    color = mobileTextSecondary,
  )
}

@Composable
private fun RenderTable(element: Map<String, Any>) {
  val columns = element.typedList("columns")
  val rows = element.typedList("rows")

  Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
    // Header row from column definitions
    if (columns.isNotEmpty()) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        for (col in columns) {
          val header = col["header"] as? String ?: ""
          Text(
            text = header,
            style = mobileCallout.copy(fontWeight = FontWeight.Bold),
            color = mobileText,
            modifier = Modifier.weight(1f),
          )
        }
      }
    }

    // Data rows
    for (row in rows) {
      val cells = row.typedList("cells")
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        for (cell in cells) {
          // Each cell may contain items or a simple text value
          val items = cell.typedList("items")
          if (items.isNotEmpty()) {
            Column(modifier = Modifier.weight(1f)) {
              for (item in items) {
                RenderElement(item)
              }
            }
          } else {
            val value = cell["value"] as? String ?: cell["text"] as? String ?: ""
            Text(
              text = value,
              style = mobileCallout,
              color = mobileTextSecondary,
              modifier = Modifier.weight(1f),
            )
          }
        }
      }
    }
  }
}

@Composable
private fun RenderRichTextBlock(element: Map<String, Any>) {
  val inlines = element.typedList("inlines")
  if (inlines.isEmpty()) return

  val annotated = buildAnnotatedString {
    for (inline in inlines) {
      val text = inline["text"] as? String ?: continue
      val isBold = inline["weight"] as? String == "Bolder" || inline["fontWeight"] as? String == "Bold"
      val isItalic = inline["italic"] == true
      val isStrikethrough = inline["strikethrough"] == true
      val isSubtle = inline["isSubtle"] == true

      val spanStyle = SpanStyle(
        fontWeight = if (isBold) FontWeight.Bold else null,
        fontStyle = if (isItalic) FontStyle.Italic else null,
        textDecoration = if (isStrikethrough) TextDecoration.LineThrough else null,
        color = if (isSubtle) mobileTextSecondary else mobileText,
      )
      withStyle(spanStyle) {
        append(text)
      }
    }
  }

  Text(text = annotated, style = mobileCallout)
}

@Composable
private fun RenderCodeBlock(element: Map<String, Any>) {
  val code = element["codeSnippet"] as? String
    ?: element["code"] as? String
    ?: element["text"] as? String
    ?: return
  val language = element["language"] as? String

  Surface(
    shape = RoundedCornerShape(8.dp),
    color = mobileCodeBg,
    border = BorderStroke(1.dp, mobileCodeBorder),
    modifier = Modifier.fillMaxWidth(),
  ) {
    Column(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      if (!language.isNullOrBlank()) {
        Text(
          text = language.uppercase(),
          style = mobileCaption1,
          color = mobileTextSecondary,
        )
      }
      Text(
        text = code.trimEnd(),
        fontFamily = FontFamily.Monospace,
        style = mobileCallout,
        color = mobileCodeText,
      )
    }
  }
}

@Composable
private fun RenderActionSet(element: Map<String, Any>) {
  val actions = element.typedList("actions")
  if (actions.isEmpty()) return

  Row(
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    modifier = Modifier.fillMaxWidth(),
  ) {
    for (action in actions) {
      RenderAction(action, modifier = Modifier.weight(1f))
    }
  }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RenderImageSet(element: Map<String, Any>) {
  val images = element.typedList("images")
  if (images.isEmpty()) return

  // TODO: Use Coil or Glide for actual image loading when available.
  FlowRow(
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    for (image in images) {
      val altText = image["altText"] as? String
      val url = image["url"] as? String ?: ""
      Text(
        text = altText ?: "[Image: $url]",
        style = mobileCaption1,
        color = mobileTextSecondary,
      )
    }
  }
}

@Composable
private fun RenderRating(element: Map<String, Any>) {
  // value can arrive as Int or Double from JSON parsing
  val rawValue = element["value"]
  val value = when (rawValue) {
    is Number -> rawValue.toDouble()
    is String -> rawValue.toDoubleOrNull() ?: 0.0
    else -> 0.0
  }
  val max = when (val rawMax = element["max"]) {
    is Number -> rawMax.toInt()
    is String -> rawMax.toIntOrNull() ?: 5
    else -> 5
  }

  val fullStars = value.toInt().coerceIn(0, max)
  val emptyStars = (max - fullStars).coerceAtLeast(0)
  val stars = "\u2605".repeat(fullStars) + "\u2606".repeat(emptyStars)

  Text(
    text = stars,
    style = mobileCallout,
    color = mobileAccent,
  )
}

@Composable
private fun RenderProgressBar(element: Map<String, Any>) {
  val rawValue = element["value"]
  val value = when (rawValue) {
    is Number -> rawValue.toFloat()
    is String -> rawValue.toFloatOrNull() ?: 0f
    else -> 0f
  }
  // Normalize: if value > 1 treat as percentage (0-100), otherwise as fraction (0-1)
  val progress = if (value > 1f) (value / 100f).coerceIn(0f, 1f) else value.coerceIn(0f, 1f)

  val label = element["label"] as? String

  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    if (!label.isNullOrBlank()) {
      Text(text = label, style = mobileCaption1, color = mobileTextSecondary)
    }
    LinearProgressIndicator(
      progress = { progress },
      modifier = Modifier.fillMaxWidth().height(6.dp),
      color = mobileAccent,
      trackColor = mobileBorder,
    )
  }
}

// -- Action rendering --

@Composable
private fun RenderAction(action: Map<String, Any>, modifier: Modifier = Modifier) {
  val title = action["title"] as? String ?: return
  val type = action["type"] as? String

  when (type) {
    "Action.OpenUrl" -> {
      val uriHandler = LocalUriHandler.current
      val url = action["url"] as? String
      OutlinedButton(
        onClick = {
          url?.let {
            try {
              uriHandler.openUri(it)
            } catch (e: Exception) {
              Log.w(TAG, "Failed to open URL: $it", e)
            }
          }
        },
        modifier = modifier,
      ) {
        Text(text = title, style = mobileCallout, color = mobileAccent)
      }
    }
    "Action.Submit", "Action.Execute" -> {
      OutlinedButton(
        onClick = { Log.d(TAG, "$type tapped: $title, data=${action["data"]}") },
        modifier = modifier,
      ) {
        Text(text = title, style = mobileCallout, color = mobileAccent)
      }
    }
    else -> {
      Log.d(TAG, "Skipping unknown action type: $type")
    }
  }
}

// -- Helpers --

/** Safely cast a list value from a loosely-typed map to List<Map<String, Any>>. */
@Suppress("UNCHECKED_CAST")
private fun Map<String, Any>.typedList(key: String): List<Map<String, Any>> {
  return (this[key] as? List<*>)
    ?.filterIsInstance<Map<*, *>>()
    ?.map { it as Map<String, Any> }
    ?: emptyList()
}
