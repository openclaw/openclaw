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

public val Icons.Filled.Link: ImageVector
  get() {
    if (cachedLink != null) {
      return cachedLink!!
    }
    cachedLink =
      materialIcon(name = "Filled.Link") {
        materialPath {
          moveTo(3.9f, 12.0f)
          curveToRelative(0.0f, -1.71f, 1.39f, -3.1f, 3.1f, -3.1f)
          horizontalLineToRelative(4.0f)
          lineTo(11.0f, 7.0f)
          lineTo(7.0f, 7.0f)
          curveToRelative(-2.76f, 0.0f, -5.0f, 2.24f, -5.0f, 5.0f)
          reflectiveCurveToRelative(2.24f, 5.0f, 5.0f, 5.0f)
          horizontalLineToRelative(4.0f)
          verticalLineToRelative(-1.9f)
          lineTo(7.0f, 15.1f)
          curveToRelative(-1.71f, 0.0f, -3.1f, -1.39f, -3.1f, -3.1f)
          close()
          moveTo(8.0f, 13.0f)
          horizontalLineToRelative(8.0f)
          verticalLineToRelative(-2.0f)
          lineTo(8.0f, 11.0f)
          verticalLineToRelative(2.0f)
          close()
          moveTo(17.0f, 7.0f)
          horizontalLineToRelative(-4.0f)
          verticalLineToRelative(1.9f)
          horizontalLineToRelative(4.0f)
          curveToRelative(1.71f, 0.0f, 3.1f, 1.39f, 3.1f, 3.1f)
          reflectiveCurveToRelative(-1.39f, 3.1f, -3.1f, 3.1f)
          horizontalLineToRelative(-4.0f)
          lineTo(13.0f, 17.0f)
          horizontalLineToRelative(4.0f)
          curveToRelative(2.76f, 0.0f, 5.0f, -2.24f, 5.0f, -5.0f)
          reflectiveCurveToRelative(-2.24f, -5.0f, -5.0f, -5.0f)
          close()
        }
      }
    return cachedLink!!
  }

private var cachedLink: ImageVector? = null
