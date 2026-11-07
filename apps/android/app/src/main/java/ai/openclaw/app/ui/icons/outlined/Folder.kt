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

public val Icons.Outlined.Folder: ImageVector
  get() {
    if (cachedFolder != null) {
      return cachedFolder!!
    }
    cachedFolder =
      materialIcon(name = "Outlined.Folder") {
        materialPath {
          moveTo(9.17f, 6.0f)
          lineToRelative(2.0f, 2.0f)
          horizontalLineTo(20.0f)
          verticalLineToRelative(10.0f)
          horizontalLineTo(4.0f)
          verticalLineTo(6.0f)
          horizontalLineToRelative(5.17f)
          moveTo(10.0f, 4.0f)
          horizontalLineTo(4.0f)
          curveToRelative(-1.1f, 0.0f, -1.99f, 0.9f, -1.99f, 2.0f)
          lineTo(2.0f, 18.0f)
          curveToRelative(0.0f, 1.1f, 0.9f, 2.0f, 2.0f, 2.0f)
          horizontalLineToRelative(16.0f)
          curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
          verticalLineTo(8.0f)
          curveToRelative(0.0f, -1.1f, -0.9f, -2.0f, -2.0f, -2.0f)
          horizontalLineToRelative(-8.0f)
          lineToRelative(-2.0f, -2.0f)
          close()
        }
      }
    return cachedFolder!!
  }

private var cachedFolder: ImageVector? = null
