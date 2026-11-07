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

public val Icons.Filled.Key: ImageVector
  get() {
    if (cachedKey != null) {
      return cachedKey!!
    }
    cachedKey =
      materialIcon(name = "Filled.Key") {
        materialPath {
          moveTo(21.0f, 10.0f)
          horizontalLineToRelative(-8.35f)
          curveTo(11.83f, 7.67f, 9.61f, 6.0f, 7.0f, 6.0f)
          curveToRelative(-3.31f, 0.0f, -6.0f, 2.69f, -6.0f, 6.0f)
          reflectiveCurveToRelative(2.69f, 6.0f, 6.0f, 6.0f)
          curveToRelative(2.61f, 0.0f, 4.83f, -1.67f, 5.65f, -4.0f)
          horizontalLineTo(13.0f)
          lineToRelative(2.0f, 2.0f)
          lineToRelative(2.0f, -2.0f)
          lineToRelative(2.0f, 2.0f)
          lineToRelative(4.0f, -4.04f)
          lineTo(21.0f, 10.0f)
          close()
          moveTo(7.0f, 15.0f)
          curveToRelative(-1.65f, 0.0f, -3.0f, -1.35f, -3.0f, -3.0f)
          curveToRelative(0.0f, -1.65f, 1.35f, -3.0f, 3.0f, -3.0f)
          reflectiveCurveToRelative(3.0f, 1.35f, 3.0f, 3.0f)
          curveTo(10.0f, 13.65f, 8.65f, 15.0f, 7.0f, 15.0f)
          close()
        }
      }
    return cachedKey!!
  }

private var cachedKey: ImageVector? = null
