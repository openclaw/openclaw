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

public val Icons.Filled.SwapHoriz: ImageVector
  get() {
    if (cachedSwapHoriz != null) {
      return cachedSwapHoriz!!
    }
    cachedSwapHoriz =
      materialIcon(name = "Filled.SwapHoriz") {
        materialPath {
          moveTo(6.99f, 11.0f)
          lineTo(3.0f, 15.0f)
          lineToRelative(3.99f, 4.0f)
          verticalLineToRelative(-3.0f)
          horizontalLineTo(14.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineTo(6.99f)
          verticalLineToRelative(-3.0f)
          close()
          moveTo(21.0f, 9.0f)
          lineToRelative(-3.99f, -4.0f)
          verticalLineToRelative(3.0f)
          horizontalLineTo(10.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(7.01f)
          verticalLineToRelative(3.0f)
          lineTo(21.0f, 9.0f)
          close()
        }
      }
    return cachedSwapHoriz!!
  }

private var cachedSwapHoriz: ImageVector? = null
