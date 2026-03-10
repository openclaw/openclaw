package ai.openclaw.app.ui.chat

import android.util.Log
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.openclaw.app.ui.mobileAccent
import ai.openclaw.app.ui.mobileBorder
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCaption1
import ai.openclaw.app.ui.mobileText
import ai.openclaw.app.ui.mobileTextSecondary

private const val TAG = "AdaptiveCard"

/**
 * Renders an Adaptive Card from a parsed JSON map inline in a chat bubble.
 * Supports TextBlock, FactSet, ColumnSet, Container, Image (placeholder),
 * Action.Submit, and Action.OpenUrl. Unknown element types are silently skipped.
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
private fun RenderElement(element: Map<String, Any>, depth: Int = 0) {
  if (depth > 10) return // Guard against unbounded recursion
  when (element["type"] as? String) {
    "TextBlock" -> RenderTextBlock(element)
    "FactSet" -> RenderFactSet(element)
    "ColumnSet" -> RenderColumnSet(element, depth + 1)
    "Container" -> RenderContainer(element, depth + 1)
    "Image" -> RenderImagePlaceholder(element)
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
private fun RenderColumnSet(element: Map<String, Any>, depth: Int = 0) {
  val columns = element.typedList("columns")
  if (columns.isEmpty()) return

  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    for (column in columns) {
      val items = column.typedList("items")
      val widthStr = column["width"] as? String
      val weight = widthStr?.removeSuffix("px")?.toFloatOrNull() ?: 1f

      Column(
        modifier = Modifier.weight(weight),
        verticalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        for (item in items) {
          RenderElement(item, depth)
        }
      }
    }
  }
}

@Composable
private fun RenderContainer(element: Map<String, Any>, depth: Int = 0) {
  val items = element.typedList("items")
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    for (item in items) {
      RenderElement(item, depth)
    }
  }
}

@Composable
private fun RenderImagePlaceholder(element: Map<String, Any>) {
  // No HTTP image loading library available; show alt text or URL as placeholder
  val altText = element["altText"] as? String
  val url = element["url"] as? String ?: ""
  Text(
    text = altText ?: "[Image: $url]",
    style = mobileCaption1,
    color = mobileTextSecondary,
  )
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
    "Action.Submit" -> {
      OutlinedButton(
        onClick = { },
        enabled = false,
        modifier = modifier,
      ) {
        Text(text = title, style = mobileCallout)
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
