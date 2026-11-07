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

public val Icons.Filled.AttachFile: ImageVector
  get() {
    if (cachedAttachFile != null) {
      return cachedAttachFile!!
    }
    cachedAttachFile =
      materialIcon(name = "Filled.AttachFile") {
        materialPath {
          moveTo(16.5f, 6.0f)
          verticalLineToRelative(11.5f)
          curveToRelative(0.0f, 2.21f, -1.79f, 4.0f, -4.0f, 4.0f)
          reflectiveCurveToRelative(-4.0f, -1.79f, -4.0f, -4.0f)
          verticalLineTo(5.0f)
          curveToRelative(0.0f, -1.38f, 1.12f, -2.5f, 2.5f, -2.5f)
          reflectiveCurveToRelative(2.5f, 1.12f, 2.5f, 2.5f)
          verticalLineToRelative(10.5f)
          curveToRelative(0.0f, 0.55f, -0.45f, 1.0f, -1.0f, 1.0f)
          reflectiveCurveToRelative(-1.0f, -0.45f, -1.0f, -1.0f)
          verticalLineTo(6.0f)
          horizontalLineTo(10.0f)
          verticalLineToRelative(9.5f)
          curveToRelative(0.0f, 1.38f, 1.12f, 2.5f, 2.5f, 2.5f)
          reflectiveCurveToRelative(2.5f, -1.12f, 2.5f, -2.5f)
          verticalLineTo(5.0f)
          curveToRelative(0.0f, -2.21f, -1.79f, -4.0f, -4.0f, -4.0f)
          reflectiveCurveTo(7.0f, 2.79f, 7.0f, 5.0f)
          verticalLineToRelative(12.5f)
          curveToRelative(0.0f, 3.04f, 2.46f, 5.5f, 5.5f, 5.5f)
          reflectiveCurveToRelative(5.5f, -2.46f, 5.5f, -5.5f)
          verticalLineTo(6.0f)
          horizontalLineToRelative(-1.5f)
          close()
        }
      }
    return cachedAttachFile!!
  }

private var cachedAttachFile: ImageVector? = null
