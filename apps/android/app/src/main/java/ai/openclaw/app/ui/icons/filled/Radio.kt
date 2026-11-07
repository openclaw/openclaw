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

public val Icons.Filled.Radio: ImageVector
  get() {
    if (cachedRadio != null) {
      return cachedRadio!!
    }
    cachedRadio =
      materialIcon(name = "Filled.Radio") {
        materialPath {
          moveTo(3.24f, 6.15f)
          curveTo(2.51f, 6.43f, 2.0f, 7.17f, 2.0f, 8.0f)
          verticalLineToRelative(12.0f)
          curveToRelative(0.0f, 1.1f, 0.89f, 2.0f, 2.0f, 2.0f)
          horizontalLineToRelative(16.0f)
          curveToRelative(1.11f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
          lineTo(22.0f, 8.0f)
          curveToRelative(0.0f, -1.11f, -0.89f, -2.0f, -2.0f, -2.0f)
          lineTo(8.3f, 6.0f)
          lineToRelative(8.26f, -3.34f)
          lineTo(15.88f, 1.0f)
          lineTo(3.24f, 6.15f)
          close()
          moveTo(7.0f, 20.0f)
          curveToRelative(-1.66f, 0.0f, -3.0f, -1.34f, -3.0f, -3.0f)
          reflectiveCurveToRelative(1.34f, -3.0f, 3.0f, -3.0f)
          reflectiveCurveToRelative(3.0f, 1.34f, 3.0f, 3.0f)
          reflectiveCurveToRelative(-1.34f, 3.0f, -3.0f, 3.0f)
          close()
          moveTo(20.0f, 12.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(2.0f)
          lineTo(4.0f, 12.0f)
          lineTo(4.0f, 8.0f)
          horizontalLineToRelative(16.0f)
          verticalLineToRelative(4.0f)
          close()
        }
      }
    return cachedRadio!!
  }

private var cachedRadio: ImageVector? = null
