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

package ai.openclaw.app.ui.icons.outlined

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.ui.graphics.vector.ImageVector

public val Icons.Outlined.AccessTime: ImageVector
  get() {
    if (cachedAccessTime != null) {
      return cachedAccessTime!!
    }
    cachedAccessTime =
      materialIcon(name = "Outlined.AccessTime") {
        materialPath {
          moveTo(11.99f, 2.0f)
          curveTo(6.47f, 2.0f, 2.0f, 6.48f, 2.0f, 12.0f)
          reflectiveCurveToRelative(4.47f, 10.0f, 9.99f, 10.0f)
          curveTo(17.52f, 22.0f, 22.0f, 17.52f, 22.0f, 12.0f)
          reflectiveCurveTo(17.52f, 2.0f, 11.99f, 2.0f)
          close()
          moveTo(12.0f, 20.0f)
          curveToRelative(-4.42f, 0.0f, -8.0f, -3.58f, -8.0f, -8.0f)
          reflectiveCurveToRelative(3.58f, -8.0f, 8.0f, -8.0f)
          reflectiveCurveToRelative(8.0f, 3.58f, 8.0f, 8.0f)
          reflectiveCurveToRelative(-3.58f, 8.0f, -8.0f, 8.0f)
          close()
          moveTo(12.5f, 7.0f)
          lineTo(11.0f, 7.0f)
          verticalLineToRelative(6.0f)
          lineToRelative(5.25f, 3.15f)
          lineToRelative(0.75f, -1.23f)
          lineToRelative(-4.5f, -2.67f)
          close()
        }
      }
    return cachedAccessTime!!
  }

private var cachedAccessTime: ImageVector? = null
