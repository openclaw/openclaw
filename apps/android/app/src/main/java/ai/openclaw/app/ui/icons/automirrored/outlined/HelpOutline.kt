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

package ai.openclaw.app.ui.icons.automirrored.outlined

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.ui.graphics.vector.ImageVector

public val Icons.AutoMirrored.Outlined.HelpOutline: ImageVector
  get() {
    if (cachedHelpOutline != null) {
      return cachedHelpOutline!!
    }
    cachedHelpOutline =
      materialIcon(name = "AutoMirrored.Outlined.HelpOutline", autoMirror = true) {
        materialPath {
          moveTo(11.0f, 18.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(2.0f)
          close()
          moveTo(12.0f, 2.0f)
          curveTo(6.48f, 2.0f, 2.0f, 6.48f, 2.0f, 12.0f)
          reflectiveCurveToRelative(4.48f, 10.0f, 10.0f, 10.0f)
          reflectiveCurveToRelative(10.0f, -4.48f, 10.0f, -10.0f)
          reflectiveCurveTo(17.52f, 2.0f, 12.0f, 2.0f)
          close()
          moveTo(12.0f, 20.0f)
          curveToRelative(-4.41f, 0.0f, -8.0f, -3.59f, -8.0f, -8.0f)
          reflectiveCurveToRelative(3.59f, -8.0f, 8.0f, -8.0f)
          reflectiveCurveToRelative(8.0f, 3.59f, 8.0f, 8.0f)
          reflectiveCurveToRelative(-3.59f, 8.0f, -8.0f, 8.0f)
          close()
          moveTo(12.0f, 6.0f)
          curveToRelative(-2.21f, 0.0f, -4.0f, 1.79f, -4.0f, 4.0f)
          horizontalLineToRelative(2.0f)
          curveToRelative(0.0f, -1.1f, 0.9f, -2.0f, 2.0f, -2.0f)
          reflectiveCurveToRelative(2.0f, 0.9f, 2.0f, 2.0f)
          curveToRelative(0.0f, 2.0f, -3.0f, 1.75f, -3.0f, 5.0f)
          horizontalLineToRelative(2.0f)
          curveToRelative(0.0f, -2.25f, 3.0f, -2.5f, 3.0f, -5.0f)
          curveToRelative(0.0f, -2.21f, -1.79f, -4.0f, -4.0f, -4.0f)
          close()
        }
      }
    return cachedHelpOutline!!
  }

private var cachedHelpOutline: ImageVector? = null
