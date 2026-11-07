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

public val Icons.Filled.Mail: ImageVector
  get() {
    if (cachedMail != null) {
      return cachedMail!!
    }
    cachedMail =
      materialIcon(name = "Filled.Mail") {
        materialPath {
          moveTo(20.0f, 4.0f)
          lineTo(4.0f, 4.0f)
          curveToRelative(-1.1f, 0.0f, -1.99f, 0.9f, -1.99f, 2.0f)
          lineTo(2.0f, 18.0f)
          curveToRelative(0.0f, 1.1f, 0.9f, 2.0f, 2.0f, 2.0f)
          horizontalLineToRelative(16.0f)
          curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
          lineTo(22.0f, 6.0f)
          curveToRelative(0.0f, -1.1f, -0.9f, -2.0f, -2.0f, -2.0f)
          close()
          moveTo(20.0f, 8.0f)
          lineToRelative(-8.0f, 5.0f)
          lineToRelative(-8.0f, -5.0f)
          lineTo(4.0f, 6.0f)
          lineToRelative(8.0f, 5.0f)
          lineToRelative(8.0f, -5.0f)
          verticalLineToRelative(2.0f)
          close()
        }
      }
    return cachedMail!!
  }

private var cachedMail: ImageVector? = null
