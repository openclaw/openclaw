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

public val Icons.AutoMirrored.Filled.VolumeUp: ImageVector
  get() {
    if (cachedVolumeUp != null) {
      return cachedVolumeUp!!
    }
    cachedVolumeUp =
      materialIcon(name = "AutoMirrored.Filled.VolumeUp", autoMirror = true) {
        materialPath {
          moveTo(3.0f, 9.0f)
          verticalLineToRelative(6.0f)
          horizontalLineToRelative(4.0f)
          lineToRelative(5.0f, 5.0f)
          lineTo(12.0f, 4.0f)
          lineTo(7.0f, 9.0f)
          lineTo(3.0f, 9.0f)
          close()
          moveTo(16.5f, 12.0f)
          curveToRelative(0.0f, -1.77f, -1.02f, -3.29f, -2.5f, -4.03f)
          verticalLineToRelative(8.05f)
          curveToRelative(1.48f, -0.73f, 2.5f, -2.25f, 2.5f, -4.02f)
          close()
          moveTo(14.0f, 3.23f)
          verticalLineToRelative(2.06f)
          curveToRelative(2.89f, 0.86f, 5.0f, 3.54f, 5.0f, 6.71f)
          reflectiveCurveToRelative(-2.11f, 5.85f, -5.0f, 6.71f)
          verticalLineToRelative(2.06f)
          curveToRelative(4.01f, -0.91f, 7.0f, -4.49f, 7.0f, -8.77f)
          reflectiveCurveToRelative(-2.99f, -7.86f, -7.0f, -8.77f)
          close()
        }
      }
    return cachedVolumeUp!!
  }

private var cachedVolumeUp: ImageVector? = null
