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

public val Icons.Filled.SmartToy: ImageVector
  get() {
    if (cachedSmartToy != null) {
      return cachedSmartToy!!
    }
    cachedSmartToy =
      materialIcon(name = "Filled.SmartToy") {
        materialPath {
          moveTo(20.0f, 9.0f)
          verticalLineTo(7.0f)
          curveToRelative(0.0f, -1.1f, -0.9f, -2.0f, -2.0f, -2.0f)
          horizontalLineToRelative(-3.0f)
          curveToRelative(0.0f, -1.66f, -1.34f, -3.0f, -3.0f, -3.0f)
          reflectiveCurveTo(9.0f, 3.34f, 9.0f, 5.0f)
          horizontalLineTo(6.0f)
          curveTo(4.9f, 5.0f, 4.0f, 5.9f, 4.0f, 7.0f)
          verticalLineToRelative(2.0f)
          curveToRelative(-1.66f, 0.0f, -3.0f, 1.34f, -3.0f, 3.0f)
          curveToRelative(0.0f, 1.66f, 1.34f, 3.0f, 3.0f, 3.0f)
          verticalLineToRelative(4.0f)
          curveToRelative(0.0f, 1.1f, 0.9f, 2.0f, 2.0f, 2.0f)
          horizontalLineToRelative(12.0f)
          curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
          verticalLineToRelative(-4.0f)
          curveToRelative(1.66f, 0.0f, 3.0f, -1.34f, 3.0f, -3.0f)
          curveTo(23.0f, 10.34f, 21.66f, 9.0f, 20.0f, 9.0f)
          close()
          moveTo(7.5f, 11.5f)
          curveTo(7.5f, 10.67f, 8.17f, 10.0f, 9.0f, 10.0f)
          reflectiveCurveToRelative(1.5f, 0.67f, 1.5f, 1.5f)
          reflectiveCurveTo(9.83f, 13.0f, 9.0f, 13.0f)
          reflectiveCurveTo(7.5f, 12.33f, 7.5f, 11.5f)
          close()
          moveTo(16.0f, 17.0f)
          horizontalLineTo(8.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(8.0f)
          verticalLineTo(17.0f)
          close()
          moveTo(15.0f, 13.0f)
          curveToRelative(-0.83f, 0.0f, -1.5f, -0.67f, -1.5f, -1.5f)
          reflectiveCurveTo(14.17f, 10.0f, 15.0f, 10.0f)
          reflectiveCurveToRelative(1.5f, 0.67f, 1.5f, 1.5f)
          reflectiveCurveTo(15.83f, 13.0f, 15.0f, 13.0f)
          close()
        }
      }
    return cachedSmartToy!!
  }

private var cachedSmartToy: ImageVector? = null
