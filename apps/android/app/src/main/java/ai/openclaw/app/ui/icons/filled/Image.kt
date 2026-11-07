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

public val Icons.Filled.Image: ImageVector
  get() {
    if (cachedImage != null) {
      return cachedImage!!
    }
    cachedImage =
      materialIcon(name = "Filled.Image") {
        materialPath {
          moveTo(21.0f, 19.0f)
          verticalLineTo(5.0f)
          curveToRelative(0.0f, -1.1f, -0.9f, -2.0f, -2.0f, -2.0f)
          horizontalLineTo(5.0f)
          curveToRelative(-1.1f, 0.0f, -2.0f, 0.9f, -2.0f, 2.0f)
          verticalLineToRelative(14.0f)
          curveToRelative(0.0f, 1.1f, 0.9f, 2.0f, 2.0f, 2.0f)
          horizontalLineToRelative(14.0f)
          curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
          close()
          moveTo(8.5f, 13.5f)
          lineToRelative(2.5f, 3.01f)
          lineTo(14.5f, 12.0f)
          lineToRelative(4.5f, 6.0f)
          horizontalLineTo(5.0f)
          lineToRelative(3.5f, -4.5f)
          close()
        }
      }
    return cachedImage!!
  }

private var cachedImage: ImageVector? = null
