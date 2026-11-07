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

public val Icons.Filled.History: ImageVector
  get() {
    if (cachedHistory != null) {
      return cachedHistory!!
    }
    cachedHistory =
      materialIcon(name = "Filled.History") {
        materialPath {
          moveTo(13.0f, 3.0f)
          curveToRelative(-4.97f, 0.0f, -9.0f, 4.03f, -9.0f, 9.0f)
          lineTo(1.0f, 12.0f)
          lineToRelative(3.89f, 3.89f)
          lineToRelative(0.07f, 0.14f)
          lineTo(9.0f, 12.0f)
          lineTo(6.0f, 12.0f)
          curveToRelative(0.0f, -3.87f, 3.13f, -7.0f, 7.0f, -7.0f)
          reflectiveCurveToRelative(7.0f, 3.13f, 7.0f, 7.0f)
          reflectiveCurveToRelative(-3.13f, 7.0f, -7.0f, 7.0f)
          curveToRelative(-1.93f, 0.0f, -3.68f, -0.79f, -4.94f, -2.06f)
          lineToRelative(-1.42f, 1.42f)
          curveTo(8.27f, 19.99f, 10.51f, 21.0f, 13.0f, 21.0f)
          curveToRelative(4.97f, 0.0f, 9.0f, -4.03f, 9.0f, -9.0f)
          reflectiveCurveToRelative(-4.03f, -9.0f, -9.0f, -9.0f)
          close()
          moveTo(12.0f, 8.0f)
          verticalLineToRelative(5.0f)
          lineToRelative(4.28f, 2.54f)
          lineToRelative(0.72f, -1.21f)
          lineToRelative(-3.5f, -2.08f)
          lineTo(13.5f, 8.0f)
          lineTo(12.0f, 8.0f)
          close()
        }
      }
    return cachedHistory!!
  }

private var cachedHistory: ImageVector? = null
