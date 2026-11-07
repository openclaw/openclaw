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

package ai.openclaw.app.ui.icons.automirrored.filled

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.ui.graphics.vector.ImageVector

public val Icons.AutoMirrored.Filled.ScreenShare: ImageVector
  get() {
    if (cachedScreenShare != null) {
      return cachedScreenShare!!
    }
    cachedScreenShare =
      materialIcon(name = "AutoMirrored.Filled.ScreenShare", autoMirror = true) {
        materialPath {
          moveTo(20.0f, 18.0f)
          curveToRelative(1.1f, 0.0f, 1.99f, -0.9f, 1.99f, -2.0f)
          lineTo(22.0f, 6.0f)
          curveToRelative(0.0f, -1.11f, -0.9f, -2.0f, -2.0f, -2.0f)
          lineTo(4.0f, 4.0f)
          curveToRelative(-1.11f, 0.0f, -2.0f, 0.89f, -2.0f, 2.0f)
          verticalLineToRelative(10.0f)
          curveToRelative(0.0f, 1.1f, 0.89f, 2.0f, 2.0f, 2.0f)
          lineTo(0.0f, 18.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(24.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(-4.0f)
          close()
          moveTo(13.0f, 14.47f)
          verticalLineToRelative(-2.19f)
          curveToRelative(-2.78f, 0.0f, -4.61f, 0.85f, -6.0f, 2.72f)
          curveToRelative(0.56f, -2.67f, 2.11f, -5.33f, 6.0f, -5.87f)
          lineTo(13.0f, 7.0f)
          lineToRelative(4.0f, 3.73f)
          lineToRelative(-4.0f, 3.74f)
          close()
        }
      }
    return cachedScreenShare!!
  }

private var cachedScreenShare: ImageVector? = null
