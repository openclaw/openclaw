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

public val Icons.Filled.Difference: ImageVector
  get() {
    if (cachedDifference != null) {
      return cachedDifference!!
    }
    cachedDifference =
      materialIcon(name = "Filled.Difference") {
        materialPath {
          moveTo(18.0f, 23.0f)
          horizontalLineTo(4.0f)
          curveToRelative(-1.1f, 0.0f, -2.0f, -0.9f, -2.0f, -2.0f)
          verticalLineTo(7.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(14.0f)
          horizontalLineToRelative(14.0f)
          verticalLineTo(23.0f)
          close()
          moveTo(15.0f, 1.0f)
          horizontalLineTo(8.0f)
          curveTo(6.9f, 1.0f, 6.01f, 1.9f, 6.01f, 3.0f)
          lineTo(6.0f, 17.0f)
          curveToRelative(0.0f, 1.1f, 0.89f, 2.0f, 1.99f, 2.0f)
          horizontalLineTo(19.0f)
          curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
          verticalLineTo(7.0f)
          lineTo(15.0f, 1.0f)
          close()
          moveTo(16.5f, 15.0f)
          horizontalLineToRelative(-6.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(6.0f)
          verticalLineTo(15.0f)
          close()
          moveTo(16.5f, 9.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineTo(9.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineTo(7.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(5.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(9.0f)
          close()
        }
      }
    return cachedDifference!!
  }

private var cachedDifference: ImageVector? = null
