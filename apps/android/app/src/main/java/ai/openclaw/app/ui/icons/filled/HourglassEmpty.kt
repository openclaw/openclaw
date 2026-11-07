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

public val Icons.Filled.HourglassEmpty: ImageVector
  get() {
    if (cachedHourglassEmpty != null) {
      return cachedHourglassEmpty!!
    }
    cachedHourglassEmpty =
      materialIcon(name = "Filled.HourglassEmpty") {
        materialPath {
          moveTo(6.0f, 2.0f)
          verticalLineToRelative(6.0f)
          horizontalLineToRelative(0.01f)
          lineTo(6.0f, 8.01f)
          lineTo(10.0f, 12.0f)
          lineToRelative(-4.0f, 4.0f)
          lineToRelative(0.01f, 0.01f)
          lineTo(6.0f, 16.01f)
          lineTo(6.0f, 22.0f)
          horizontalLineToRelative(12.0f)
          verticalLineToRelative(-5.99f)
          horizontalLineToRelative(-0.01f)
          lineTo(18.0f, 16.0f)
          lineToRelative(-4.0f, -4.0f)
          lineToRelative(4.0f, -3.99f)
          lineToRelative(-0.01f, -0.01f)
          lineTo(18.0f, 8.0f)
          lineTo(18.0f, 2.0f)
          lineTo(6.0f, 2.0f)
          close()
          moveTo(16.0f, 16.5f)
          lineTo(16.0f, 20.0f)
          lineTo(8.0f, 20.0f)
          verticalLineToRelative(-3.5f)
          lineToRelative(4.0f, -4.0f)
          lineToRelative(4.0f, 4.0f)
          close()
          moveTo(12.0f, 11.5f)
          lineToRelative(-4.0f, -4.0f)
          lineTo(8.0f, 4.0f)
          horizontalLineToRelative(8.0f)
          verticalLineToRelative(3.5f)
          lineToRelative(-4.0f, 4.0f)
          close()
        }
      }
    return cachedHourglassEmpty!!
  }

private var cachedHourglassEmpty: ImageVector? = null
