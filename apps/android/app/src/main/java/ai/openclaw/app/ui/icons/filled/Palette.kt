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

public val Icons.Filled.Palette: ImageVector
  get() {
    if (cachedPalette != null) {
      return cachedPalette!!
    }
    cachedPalette =
      materialIcon(name = "Filled.Palette") {
        materialPath {
          moveTo(12.0f, 2.0f)
          curveTo(6.49f, 2.0f, 2.0f, 6.49f, 2.0f, 12.0f)
          reflectiveCurveToRelative(4.49f, 10.0f, 10.0f, 10.0f)
          curveToRelative(1.38f, 0.0f, 2.5f, -1.12f, 2.5f, -2.5f)
          curveToRelative(0.0f, -0.61f, -0.23f, -1.2f, -0.64f, -1.67f)
          curveToRelative(-0.08f, -0.1f, -0.13f, -0.21f, -0.13f, -0.33f)
          curveToRelative(0.0f, -0.28f, 0.22f, -0.5f, 0.5f, -0.5f)
          horizontalLineTo(16.0f)
          curveToRelative(3.31f, 0.0f, 6.0f, -2.69f, 6.0f, -6.0f)
          curveTo(22.0f, 6.04f, 17.51f, 2.0f, 12.0f, 2.0f)
          close()
          moveTo(17.5f, 13.0f)
          curveToRelative(-0.83f, 0.0f, -1.5f, -0.67f, -1.5f, -1.5f)
          curveToRelative(0.0f, -0.83f, 0.67f, -1.5f, 1.5f, -1.5f)
          reflectiveCurveToRelative(1.5f, 0.67f, 1.5f, 1.5f)
          curveTo(19.0f, 12.33f, 18.33f, 13.0f, 17.5f, 13.0f)
          close()
          moveTo(14.5f, 9.0f)
          curveTo(13.67f, 9.0f, 13.0f, 8.33f, 13.0f, 7.5f)
          curveTo(13.0f, 6.67f, 13.67f, 6.0f, 14.5f, 6.0f)
          reflectiveCurveTo(16.0f, 6.67f, 16.0f, 7.5f)
          curveTo(16.0f, 8.33f, 15.33f, 9.0f, 14.5f, 9.0f)
          close()
          moveTo(5.0f, 11.5f)
          curveTo(5.0f, 10.67f, 5.67f, 10.0f, 6.5f, 10.0f)
          reflectiveCurveTo(8.0f, 10.67f, 8.0f, 11.5f)
          curveTo(8.0f, 12.33f, 7.33f, 13.0f, 6.5f, 13.0f)
          reflectiveCurveTo(5.0f, 12.33f, 5.0f, 11.5f)
          close()
          moveTo(11.0f, 7.5f)
          curveTo(11.0f, 8.33f, 10.33f, 9.0f, 9.5f, 9.0f)
          reflectiveCurveTo(8.0f, 8.33f, 8.0f, 7.5f)
          curveTo(8.0f, 6.67f, 8.67f, 6.0f, 9.5f, 6.0f)
          reflectiveCurveTo(11.0f, 6.67f, 11.0f, 7.5f)
          close()
        }
      }
    return cachedPalette!!
  }

private var cachedPalette: ImageVector? = null
