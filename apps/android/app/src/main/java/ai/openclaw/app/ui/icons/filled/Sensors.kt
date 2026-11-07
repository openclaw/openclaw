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

public val Icons.Filled.Sensors: ImageVector
  get() {
    if (cachedSensors != null) {
      return cachedSensors!!
    }
    cachedSensors =
      materialIcon(name = "Filled.Sensors") {
        materialPath {
          moveTo(7.76f, 16.24f)
          curveTo(6.67f, 15.16f, 6.0f, 13.66f, 6.0f, 12.0f)
          reflectiveCurveToRelative(0.67f, -3.16f, 1.76f, -4.24f)
          lineToRelative(1.42f, 1.42f)
          curveTo(8.45f, 9.9f, 8.0f, 10.9f, 8.0f, 12.0f)
          curveToRelative(0.0f, 1.1f, 0.45f, 2.1f, 1.17f, 2.83f)
          lineTo(7.76f, 16.24f)
          close()
          moveTo(16.24f, 16.24f)
          curveTo(17.33f, 15.16f, 18.0f, 13.66f, 18.0f, 12.0f)
          reflectiveCurveToRelative(-0.67f, -3.16f, -1.76f, -4.24f)
          lineToRelative(-1.42f, 1.42f)
          curveTo(15.55f, 9.9f, 16.0f, 10.9f, 16.0f, 12.0f)
          curveToRelative(0.0f, 1.1f, -0.45f, 2.1f, -1.17f, 2.83f)
          lineTo(16.24f, 16.24f)
          close()
          moveTo(12.0f, 10.0f)
          curveToRelative(-1.1f, 0.0f, -2.0f, 0.9f, -2.0f, 2.0f)
          reflectiveCurveToRelative(0.9f, 2.0f, 2.0f, 2.0f)
          reflectiveCurveToRelative(2.0f, -0.9f, 2.0f, -2.0f)
          reflectiveCurveTo(13.1f, 10.0f, 12.0f, 10.0f)
          close()
          moveTo(20.0f, 12.0f)
          curveToRelative(0.0f, 2.21f, -0.9f, 4.21f, -2.35f, 5.65f)
          lineToRelative(1.42f, 1.42f)
          curveTo(20.88f, 17.26f, 22.0f, 14.76f, 22.0f, 12.0f)
          reflectiveCurveToRelative(-1.12f, -5.26f, -2.93f, -7.07f)
          lineToRelative(-1.42f, 1.42f)
          curveTo(19.1f, 7.79f, 20.0f, 9.79f, 20.0f, 12.0f)
          close()
          moveTo(6.35f, 6.35f)
          lineTo(4.93f, 4.93f)
          curveTo(3.12f, 6.74f, 2.0f, 9.24f, 2.0f, 12.0f)
          reflectiveCurveToRelative(1.12f, 5.26f, 2.93f, 7.07f)
          lineToRelative(1.42f, -1.42f)
          curveTo(4.9f, 16.21f, 4.0f, 14.21f, 4.0f, 12.0f)
          reflectiveCurveTo(4.9f, 7.79f, 6.35f, 6.35f)
          close()
        }
      }
    return cachedSensors!!
  }

private var cachedSensors: ImageVector? = null
