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

public val Icons.Outlined.Shield: ImageVector
  get() {
    if (cachedShield != null) {
      return cachedShield!!
    }
    cachedShield =
      materialIcon(name = "Outlined.Shield") {
        materialPath {
          moveTo(12.0f, 2.0f)
          lineTo(4.0f, 5.0f)
          verticalLineToRelative(6.09f)
          curveToRelative(0.0f, 5.05f, 3.41f, 9.76f, 8.0f, 10.91f)
          curveToRelative(4.59f, -1.15f, 8.0f, -5.86f, 8.0f, -10.91f)
          verticalLineTo(5.0f)
          lineTo(12.0f, 2.0f)
          close()
          moveTo(18.0f, 11.09f)
          curveToRelative(0.0f, 4.0f, -2.55f, 7.7f, -6.0f, 8.83f)
          curveToRelative(-3.45f, -1.13f, -6.0f, -4.82f, -6.0f, -8.83f)
          verticalLineToRelative(-4.7f)
          lineToRelative(6.0f, -2.25f)
          lineToRelative(6.0f, 2.25f)
          verticalLineTo(11.09f)
          close()
        }
      }
    return cachedShield!!
  }

private var cachedShield: ImageVector? = null
