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

public val Icons.Filled.PendingActions: ImageVector
  get() {
    if (cachedPendingActions != null) {
      return cachedPendingActions!!
    }
    cachedPendingActions =
      materialIcon(name = "Filled.PendingActions") {
        materialPath {
          moveTo(17.0f, 12.0f)
          curveToRelative(-2.76f, 0.0f, -5.0f, 2.24f, -5.0f, 5.0f)
          reflectiveCurveToRelative(2.24f, 5.0f, 5.0f, 5.0f)
          curveToRelative(2.76f, 0.0f, 5.0f, -2.24f, 5.0f, -5.0f)
          reflectiveCurveTo(19.76f, 12.0f, 17.0f, 12.0f)
          close()
          moveTo(18.65f, 19.35f)
          lineToRelative(-2.15f, -2.15f)
          verticalLineTo(14.0f)
          horizontalLineToRelative(1.0f)
          verticalLineToRelative(2.79f)
          lineToRelative(1.85f, 1.85f)
          lineTo(18.65f, 19.35f)
          close()
          moveTo(18.0f, 3.0f)
          horizontalLineToRelative(-3.18f)
          curveTo(14.4f, 1.84f, 13.3f, 1.0f, 12.0f, 1.0f)
          reflectiveCurveTo(9.6f, 1.84f, 9.18f, 3.0f)
          horizontalLineTo(6.0f)
          curveTo(4.9f, 3.0f, 4.0f, 3.9f, 4.0f, 5.0f)
          verticalLineToRelative(15.0f)
          curveToRelative(0.0f, 1.1f, 0.9f, 2.0f, 2.0f, 2.0f)
          horizontalLineToRelative(6.11f)
          curveToRelative(-0.59f, -0.57f, -1.07f, -1.25f, -1.42f, -2.0f)
          horizontalLineTo(6.0f)
          verticalLineTo(5.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(3.0f)
          horizontalLineToRelative(8.0f)
          verticalLineTo(5.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(5.08f)
          curveToRelative(0.71f, 0.1f, 1.38f, 0.31f, 2.0f, 0.6f)
          verticalLineTo(5.0f)
          curveTo(20.0f, 3.9f, 19.1f, 3.0f, 18.0f, 3.0f)
          close()
          moveTo(12.0f, 5.0f)
          curveToRelative(-0.55f, 0.0f, -1.0f, -0.45f, -1.0f, -1.0f)
          curveToRelative(0.0f, -0.55f, 0.45f, -1.0f, 1.0f, -1.0f)
          curveToRelative(0.55f, 0.0f, 1.0f, 0.45f, 1.0f, 1.0f)
          curveTo(13.0f, 4.55f, 12.55f, 5.0f, 12.0f, 5.0f)
          close()
        }
      }
    return cachedPendingActions!!
  }

private var cachedPendingActions: ImageVector? = null
