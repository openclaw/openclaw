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

public val Icons.Filled.BorderColor: ImageVector
  get() {
    if (cachedBorderColor != null) {
      return cachedBorderColor!!
    }
    cachedBorderColor =
      materialIcon(name = "Filled.BorderColor") {
        materialPath {
          moveTo(22.0f, 24.0f)
          horizontalLineTo(2.0f)
          verticalLineToRelative(-4.0f)
          horizontalLineToRelative(20.0f)
          verticalLineTo(24.0f)
          close()
          moveTo(13.06f, 5.19f)
          lineToRelative(3.75f, 3.75f)
          lineTo(7.75f, 18.0f)
          horizontalLineTo(4.0f)
          verticalLineToRelative(-3.75f)
          lineTo(13.06f, 5.19f)
          close()
          moveTo(17.88f, 7.87f)
          lineToRelative(-3.75f, -3.75f)
          lineToRelative(1.83f, -1.83f)
          curveToRelative(0.39f, -0.39f, 1.02f, -0.39f, 1.41f, 0.0f)
          lineToRelative(2.34f, 2.34f)
          curveToRelative(0.39f, 0.39f, 0.39f, 1.02f, 0.0f, 1.41f)
          lineTo(17.88f, 7.87f)
          close()
        }
      }
    return cachedBorderColor!!
  }

private var cachedBorderColor: ImageVector? = null
