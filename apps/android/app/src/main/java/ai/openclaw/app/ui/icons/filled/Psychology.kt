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

public val Icons.Filled.Psychology: ImageVector
  get() {
    if (cachedPsychology != null) {
      return cachedPsychology!!
    }
    cachedPsychology =
      materialIcon(name = "Filled.Psychology") {
        materialPath {
          moveTo(13.0f, 8.57f)
          curveToRelative(-0.79f, 0.0f, -1.43f, 0.64f, -1.43f, 1.43f)
          reflectiveCurveToRelative(0.64f, 1.43f, 1.43f, 1.43f)
          reflectiveCurveToRelative(1.43f, -0.64f, 1.43f, -1.43f)
          reflectiveCurveTo(13.79f, 8.57f, 13.0f, 8.57f)
          close()
        }
        materialPath {
          moveTo(13.0f, 3.0f)
          curveTo(9.25f, 3.0f, 6.2f, 5.94f, 6.02f, 9.64f)
          lineTo(4.1f, 12.2f)
          curveTo(3.85f, 12.53f, 4.09f, 13.0f, 4.5f, 13.0f)
          horizontalLineTo(6.0f)
          verticalLineToRelative(3.0f)
          curveToRelative(0.0f, 1.1f, 0.9f, 2.0f, 2.0f, 2.0f)
          horizontalLineToRelative(1.0f)
          verticalLineToRelative(3.0f)
          horizontalLineToRelative(7.0f)
          verticalLineToRelative(-4.68f)
          curveToRelative(2.36f, -1.12f, 4.0f, -3.53f, 4.0f, -6.32f)
          curveTo(20.0f, 6.13f, 16.87f, 3.0f, 13.0f, 3.0f)
          close()
          moveTo(16.0f, 10.0f)
          curveToRelative(0.0f, 0.13f, -0.01f, 0.26f, -0.02f, 0.39f)
          lineToRelative(0.83f, 0.66f)
          curveToRelative(0.08f, 0.06f, 0.1f, 0.16f, 0.05f, 0.25f)
          lineToRelative(-0.8f, 1.39f)
          curveToRelative(-0.05f, 0.09f, -0.16f, 0.12f, -0.24f, 0.09f)
          lineToRelative(-0.99f, -0.4f)
          curveToRelative(-0.21f, 0.16f, -0.43f, 0.29f, -0.67f, 0.39f)
          lineTo(14.0f, 13.83f)
          curveToRelative(-0.01f, 0.1f, -0.1f, 0.17f, -0.2f, 0.17f)
          horizontalLineToRelative(-1.6f)
          curveToRelative(-0.1f, 0.0f, -0.18f, -0.07f, -0.2f, -0.17f)
          lineToRelative(-0.15f, -1.06f)
          curveToRelative(-0.25f, -0.1f, -0.47f, -0.23f, -0.68f, -0.39f)
          lineToRelative(-0.99f, 0.4f)
          curveToRelative(-0.09f, 0.03f, -0.2f, 0.0f, -0.25f, -0.09f)
          lineToRelative(-0.8f, -1.39f)
          curveToRelative(-0.05f, -0.08f, -0.03f, -0.19f, 0.05f, -0.25f)
          lineToRelative(0.84f, -0.66f)
          curveTo(10.01f, 10.26f, 10.0f, 10.13f, 10.0f, 10.0f)
          curveToRelative(0.0f, -0.13f, 0.02f, -0.27f, 0.04f, -0.39f)
          lineTo(9.19f, 8.95f)
          curveToRelative(-0.08f, -0.06f, -0.1f, -0.16f, -0.05f, -0.26f)
          lineToRelative(0.8f, -1.38f)
          curveToRelative(0.05f, -0.09f, 0.15f, -0.12f, 0.24f, -0.09f)
          lineToRelative(1.0f, 0.4f)
          curveToRelative(0.2f, -0.15f, 0.43f, -0.29f, 0.67f, -0.39f)
          lineToRelative(0.15f, -1.06f)
          curveTo(12.02f, 6.07f, 12.1f, 6.0f, 12.2f, 6.0f)
          horizontalLineToRelative(1.6f)
          curveToRelative(0.1f, 0.0f, 0.18f, 0.07f, 0.2f, 0.17f)
          lineToRelative(0.15f, 1.06f)
          curveToRelative(0.24f, 0.1f, 0.46f, 0.23f, 0.67f, 0.39f)
          lineToRelative(1.0f, -0.4f)
          curveToRelative(0.09f, -0.03f, 0.2f, 0.0f, 0.24f, 0.09f)
          lineToRelative(0.8f, 1.38f)
          curveToRelative(0.05f, 0.09f, 0.03f, 0.2f, -0.05f, 0.26f)
          lineToRelative(-0.85f, 0.66f)
          curveTo(15.99f, 9.73f, 16.0f, 9.86f, 16.0f, 10.0f)
          close()
        }
      }
    return cachedPsychology!!
  }

private var cachedPsychology: ImageVector? = null
