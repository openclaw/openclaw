/*
 * Copyright 2025 The Android Open Source Project
 * Modified for OpenClaw: relocated package and renamed private vector cache.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package ai.openclaw.app.ui.icons.filled

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.ui.graphics.vector.ImageVector

public val Icons.Filled.Language: ImageVector
  get() {
    if (cachedLanguage != null) {
      return cachedLanguage!!
    }
    cachedLanguage =
      materialIcon(name = "Filled.Language") {
        materialPath {
          moveTo(11.99f, 2.0f)
          curveTo(6.47f, 2.0f, 2.0f, 6.48f, 2.0f, 12.0f)
          reflectiveCurveToRelative(4.47f, 10.0f, 9.99f, 10.0f)
          curveTo(17.52f, 22.0f, 22.0f, 17.52f, 22.0f, 12.0f)
          reflectiveCurveTo(17.52f, 2.0f, 11.99f, 2.0f)
          close()
          moveTo(18.92f, 8.0f)
          horizontalLineToRelative(-2.95f)
          curveToRelative(-0.32f, -1.25f, -0.78f, -2.45f, -1.38f, -3.56f)
          curveToRelative(1.84f, 0.63f, 3.37f, 1.91f, 4.33f, 3.56f)
          close()
          moveTo(12.0f, 4.04f)
          curveToRelative(0.83f, 1.2f, 1.48f, 2.53f, 1.91f, 3.96f)
          horizontalLineToRelative(-3.82f)
          curveToRelative(0.43f, -1.43f, 1.08f, -2.76f, 1.91f, -3.96f)
          close()
          moveTo(4.26f, 14.0f)
          curveTo(4.1f, 13.36f, 4.0f, 12.69f, 4.0f, 12.0f)
          reflectiveCurveToRelative(0.1f, -1.36f, 0.26f, -2.0f)
          horizontalLineToRelative(3.38f)
          curveToRelative(-0.08f, 0.66f, -0.14f, 1.32f, -0.14f, 2.0f)
          curveToRelative(0.0f, 0.68f, 0.06f, 1.34f, 0.14f, 2.0f)
          lineTo(4.26f, 14.0f)
          close()
          moveTo(5.08f, 16.0f)
          horizontalLineToRelative(2.95f)
          curveToRelative(0.32f, 1.25f, 0.78f, 2.45f, 1.38f, 3.56f)
          curveToRelative(-1.84f, -0.63f, -3.37f, -1.9f, -4.33f, -3.56f)
          close()
          moveTo(8.03f, 8.0f)
          lineTo(5.08f, 8.0f)
          curveToRelative(0.96f, -1.66f, 2.49f, -2.93f, 4.33f, -3.56f)
          curveTo(8.81f, 5.55f, 8.35f, 6.75f, 8.03f, 8.0f)
          close()
          moveTo(12.0f, 19.96f)
          curveToRelative(-0.83f, -1.2f, -1.48f, -2.53f, -1.91f, -3.96f)
          horizontalLineToRelative(3.82f)
          curveToRelative(-0.43f, 1.43f, -1.08f, 2.76f, -1.91f, 3.96f)
          close()
          moveTo(14.34f, 14.0f)
          lineTo(9.66f, 14.0f)
          curveToRelative(-0.09f, -0.66f, -0.16f, -1.32f, -0.16f, -2.0f)
          curveToRelative(0.0f, -0.68f, 0.07f, -1.35f, 0.16f, -2.0f)
          horizontalLineToRelative(4.68f)
          curveToRelative(0.09f, 0.65f, 0.16f, 1.32f, 0.16f, 2.0f)
          curveToRelative(0.0f, 0.68f, -0.07f, 1.34f, -0.16f, 2.0f)
          close()
          moveTo(14.59f, 19.56f)
          curveToRelative(0.6f, -1.11f, 1.06f, -2.31f, 1.38f, -3.56f)
          horizontalLineToRelative(2.95f)
          curveToRelative(-0.96f, 1.65f, -2.49f, 2.93f, -4.33f, 3.56f)
          close()
          moveTo(16.36f, 14.0f)
          curveToRelative(0.08f, -0.66f, 0.14f, -1.32f, 0.14f, -2.0f)
          curveToRelative(0.0f, -0.68f, -0.06f, -1.34f, -0.14f, -2.0f)
          horizontalLineToRelative(3.38f)
          curveToRelative(0.16f, 0.64f, 0.26f, 1.31f, 0.26f, 2.0f)
          reflectiveCurveToRelative(-0.1f, 1.36f, -0.26f, 2.0f)
          horizontalLineToRelative(-3.38f)
          close()
        }
      }
    return cachedLanguage!!
  }

private var cachedLanguage: ImageVector? = null
