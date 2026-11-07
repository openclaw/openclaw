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

public val Icons.Filled.Devices: ImageVector
  get() {
    if (cachedDevices != null) {
      return cachedDevices!!
    }
    cachedDevices =
      materialIcon(name = "Filled.Devices") {
        materialPath {
          moveTo(4.0f, 6.0f)
          horizontalLineToRelative(18.0f)
          lineTo(22.0f, 4.0f)
          lineTo(4.0f, 4.0f)
          curveToRelative(-1.1f, 0.0f, -2.0f, 0.9f, -2.0f, 2.0f)
          verticalLineToRelative(11.0f)
          lineTo(0.0f, 17.0f)
          verticalLineToRelative(3.0f)
          horizontalLineToRelative(14.0f)
          verticalLineToRelative(-3.0f)
          lineTo(4.0f, 17.0f)
          lineTo(4.0f, 6.0f)
          close()
          moveTo(23.0f, 8.0f)
          horizontalLineToRelative(-6.0f)
          curveToRelative(-0.55f, 0.0f, -1.0f, 0.45f, -1.0f, 1.0f)
          verticalLineToRelative(10.0f)
          curveToRelative(0.0f, 0.55f, 0.45f, 1.0f, 1.0f, 1.0f)
          horizontalLineToRelative(6.0f)
          curveToRelative(0.55f, 0.0f, 1.0f, -0.45f, 1.0f, -1.0f)
          lineTo(24.0f, 9.0f)
          curveToRelative(0.0f, -0.55f, -0.45f, -1.0f, -1.0f, -1.0f)
          close()
          moveTo(22.0f, 17.0f)
          horizontalLineToRelative(-4.0f)
          verticalLineToRelative(-7.0f)
          horizontalLineToRelative(4.0f)
          verticalLineToRelative(7.0f)
          close()
        }
      }
    return cachedDevices!!
  }

private var cachedDevices: ImageVector? = null
