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

public val Icons.Filled.Shield: ImageVector
  get() {
    if (cachedShield != null) {
      return cachedShield!!
    }
    cachedShield =
      materialIcon(name = "Filled.Shield") {
        materialPath {
          moveTo(12.0f, 1.0f)
          lineTo(3.0f, 5.0f)
          verticalLineToRelative(6.0f)
          curveToRelative(0.0f, 5.55f, 3.84f, 10.74f, 9.0f, 12.0f)
          curveToRelative(5.16f, -1.26f, 9.0f, -6.45f, 9.0f, -12.0f)
          verticalLineTo(5.0f)
          lineToRelative(-9.0f, -4.0f)
          close()
        }
      }
    return cachedShield!!
  }

private var cachedShield: ImageVector? = null
