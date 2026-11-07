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

public val Icons.Filled.Security: ImageVector
  get() {
    if (cachedSecurity != null) {
      return cachedSecurity!!
    }
    cachedSecurity =
      materialIcon(name = "Filled.Security") {
        materialPath {
          moveTo(12.0f, 1.0f)
          lineTo(3.0f, 5.0f)
          verticalLineToRelative(6.0f)
          curveToRelative(0.0f, 5.55f, 3.84f, 10.74f, 9.0f, 12.0f)
          curveToRelative(5.16f, -1.26f, 9.0f, -6.45f, 9.0f, -12.0f)
          lineTo(21.0f, 5.0f)
          lineToRelative(-9.0f, -4.0f)
          close()
          moveTo(12.0f, 11.99f)
          horizontalLineToRelative(7.0f)
          curveToRelative(-0.53f, 4.12f, -3.28f, 7.79f, -7.0f, 8.94f)
          lineTo(12.0f, 12.0f)
          lineTo(5.0f, 12.0f)
          lineTo(5.0f, 6.3f)
          lineToRelative(7.0f, -3.11f)
          verticalLineToRelative(8.8f)
          close()
        }
      }
    return cachedSecurity!!
  }

private var cachedSecurity: ImageVector? = null
