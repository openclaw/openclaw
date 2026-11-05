package ai.openclaw.app.ui.design

import ai.openclaw.app.currentAppLanguage
import ai.openclaw.app.ui.localizedUppercase
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

@Composable
internal fun ClawAvatarMark(
  text: String,
  modifier: Modifier = Modifier,
) {
  Surface(
    modifier = modifier.size(34.dp),
    shape = CircleShape,
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Box(modifier = Modifier.padding(4.dp), contentAlignment = Alignment.Center) {
      val label = ClawTheme.type.label
      // A fixed sp line height would still clip when autosizing shrinks the initials.
      Text(
        text = localizedUppercase(text.take(2), currentAppLanguage().languageTag),
        style = label.copy(lineHeight = (label.lineHeight.value / label.fontSize.value).em),
        maxLines = 1,
        autoSize = TextAutoSize.StepBased(minFontSize = 1.sp, maxFontSize = label.fontSize),
      )
    }
  }
}
