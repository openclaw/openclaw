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

public val Icons.Outlined.MicNone: ImageVector
  get() {
    if (cachedMicNone != null) {
      return cachedMicNone!!
    }
    cachedMicNone =
      materialIcon(name = "Outlined.MicNone") {
        materialPath {
          moveTo(12.0f, 14.0f)
          curveToRelative(1.66f, 0.0f, 3.0f, -1.34f, 3.0f, -3.0f)
          lineTo(15.0f, 5.0f)
          curveToRelative(0.0f, -1.66f, -1.34f, -3.0f, -3.0f, -3.0f)
          reflectiveCurveTo(9.0f, 3.34f, 9.0f, 5.0f)
          verticalLineToRelative(6.0f)
          curveToRelative(0.0f, 1.66f, 1.34f, 3.0f, 3.0f, 3.0f)
          close()
          moveTo(11.0f, 5.0f)
          curveToRelative(0.0f, -0.55f, 0.45f, -1.0f, 1.0f, -1.0f)
          reflectiveCurveToRelative(1.0f, 0.45f, 1.0f, 1.0f)
          verticalLineToRelative(6.0f)
          curveToRelative(0.0f, 0.55f, -0.45f, 1.0f, -1.0f, 1.0f)
          reflectiveCurveToRelative(-1.0f, -0.45f, -1.0f, -1.0f)
          lineTo(11.0f, 5.0f)
          close()
          moveTo(17.0f, 11.0f)
          curveToRelative(0.0f, 2.76f, -2.24f, 5.0f, -5.0f, 5.0f)
          reflectiveCurveToRelative(-5.0f, -2.24f, -5.0f, -5.0f)
          lineTo(5.0f, 11.0f)
          curveToRelative(0.0f, 3.53f, 2.61f, 6.43f, 6.0f, 6.92f)
          lineTo(11.0f, 21.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(-3.08f)
          curveToRelative(3.39f, -0.49f, 6.0f, -3.39f, 6.0f, -6.92f)
          horizontalLineToRelative(-2.0f)
          close()
        }
      }
    return cachedMicNone!!
  }

private var cachedMicNone: ImageVector? = null
