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

public val Icons.Filled.WifiTethering: ImageVector
  get() {
    if (cachedWifiTethering != null) {
      return cachedWifiTethering!!
    }
    cachedWifiTethering =
      materialIcon(name = "Filled.WifiTethering") {
        materialPath {
          moveTo(12.0f, 11.0f)
          curveToRelative(-1.1f, 0.0f, -2.0f, 0.9f, -2.0f, 2.0f)
          reflectiveCurveToRelative(0.9f, 2.0f, 2.0f, 2.0f)
          reflectiveCurveToRelative(2.0f, -0.9f, 2.0f, -2.0f)
          reflectiveCurveToRelative(-0.9f, -2.0f, -2.0f, -2.0f)
          close()
          moveTo(18.0f, 13.0f)
          curveToRelative(0.0f, -3.31f, -2.69f, -6.0f, -6.0f, -6.0f)
          reflectiveCurveToRelative(-6.0f, 2.69f, -6.0f, 6.0f)
          curveToRelative(0.0f, 2.22f, 1.21f, 4.15f, 3.0f, 5.19f)
          lineToRelative(1.0f, -1.74f)
          curveToRelative(-1.19f, -0.7f, -2.0f, -1.97f, -2.0f, -3.45f)
          curveToRelative(0.0f, -2.21f, 1.79f, -4.0f, 4.0f, -4.0f)
          reflectiveCurveToRelative(4.0f, 1.79f, 4.0f, 4.0f)
          curveToRelative(0.0f, 1.48f, -0.81f, 2.75f, -2.0f, 3.45f)
          lineToRelative(1.0f, 1.74f)
          curveToRelative(1.79f, -1.04f, 3.0f, -2.97f, 3.0f, -5.19f)
          close()
          moveTo(12.0f, 3.0f)
          curveTo(6.48f, 3.0f, 2.0f, 7.48f, 2.0f, 13.0f)
          curveToRelative(0.0f, 3.7f, 2.01f, 6.92f, 4.99f, 8.65f)
          lineToRelative(1.0f, -1.73f)
          curveTo(5.61f, 18.53f, 4.0f, 15.96f, 4.0f, 13.0f)
          curveToRelative(0.0f, -4.42f, 3.58f, -8.0f, 8.0f, -8.0f)
          reflectiveCurveToRelative(8.0f, 3.58f, 8.0f, 8.0f)
          curveToRelative(0.0f, 2.96f, -1.61f, 5.53f, -4.0f, 6.92f)
          lineToRelative(1.0f, 1.73f)
          curveToRelative(2.99f, -1.73f, 5.0f, -4.95f, 5.0f, -8.65f)
          curveToRelative(0.0f, -5.52f, -4.48f, -10.0f, -10.0f, -10.0f)
          close()
        }
      }
    return cachedWifiTethering!!
  }

private var cachedWifiTethering: ImageVector? = null
