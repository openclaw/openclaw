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

public val Icons.Filled.CameraAlt: ImageVector
  get() {
    if (cachedCameraAlt != null) {
      return cachedCameraAlt!!
    }
    cachedCameraAlt =
      materialIcon(name = "Filled.CameraAlt") {
        materialPath {
          moveTo(12.0f, 12.0f)
          moveToRelative(-3.2f, 0.0f)
          arcToRelative(3.2f, 3.2f, 0.0f, true, true, 6.4f, 0.0f)
          arcToRelative(3.2f, 3.2f, 0.0f, true, true, -6.4f, 0.0f)
        }
        materialPath {
          moveTo(9.0f, 2.0f)
          lineTo(7.17f, 4.0f)
          lineTo(4.0f, 4.0f)
          curveToRelative(-1.1f, 0.0f, -2.0f, 0.9f, -2.0f, 2.0f)
          verticalLineToRelative(12.0f)
          curveToRelative(0.0f, 1.1f, 0.9f, 2.0f, 2.0f, 2.0f)
          horizontalLineToRelative(16.0f)
          curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
          lineTo(22.0f, 6.0f)
          curveToRelative(0.0f, -1.1f, -0.9f, -2.0f, -2.0f, -2.0f)
          horizontalLineToRelative(-3.17f)
          lineTo(15.0f, 2.0f)
          lineTo(9.0f, 2.0f)
          close()
          moveTo(12.0f, 17.0f)
          curveToRelative(-2.76f, 0.0f, -5.0f, -2.24f, -5.0f, -5.0f)
          reflectiveCurveToRelative(2.24f, -5.0f, 5.0f, -5.0f)
          reflectiveCurveToRelative(5.0f, 2.24f, 5.0f, 5.0f)
          reflectiveCurveToRelative(-2.24f, 5.0f, -5.0f, 5.0f)
          close()
        }
      }
    return cachedCameraAlt!!
  }

private var cachedCameraAlt: ImageVector? = null
