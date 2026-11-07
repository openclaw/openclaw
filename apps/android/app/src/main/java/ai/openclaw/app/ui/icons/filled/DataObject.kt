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

public val Icons.Filled.DataObject: ImageVector
  get() {
    if (cachedDataObject != null) {
      return cachedDataObject!!
    }
    cachedDataObject =
      materialIcon(name = "Filled.DataObject") {
        materialPath {
          moveTo(4.0f, 7.0f)
          verticalLineToRelative(2.0f)
          curveToRelative(0.0f, 0.55f, -0.45f, 1.0f, -1.0f, 1.0f)
          horizontalLineTo(2.0f)
          verticalLineToRelative(4.0f)
          horizontalLineToRelative(1.0f)
          curveToRelative(0.55f, 0.0f, 1.0f, 0.45f, 1.0f, 1.0f)
          verticalLineToRelative(2.0f)
          curveToRelative(0.0f, 1.65f, 1.35f, 3.0f, 3.0f, 3.0f)
          horizontalLineToRelative(3.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineTo(7.0f)
          curveToRelative(-0.55f, 0.0f, -1.0f, -0.45f, -1.0f, -1.0f)
          verticalLineToRelative(-2.0f)
          curveToRelative(0.0f, -1.3f, -0.84f, -2.42f, -2.0f, -2.83f)
          verticalLineToRelative(-0.34f)
          curveTo(5.16f, 11.42f, 6.0f, 10.3f, 6.0f, 9.0f)
          verticalLineTo(7.0f)
          curveToRelative(0.0f, -0.55f, 0.45f, -1.0f, 1.0f, -1.0f)
          horizontalLineToRelative(3.0f)
          verticalLineTo(4.0f)
          horizontalLineTo(7.0f)
          curveTo(5.35f, 4.0f, 4.0f, 5.35f, 4.0f, 7.0f)
          close()
        }
        materialPath {
          moveTo(21.0f, 10.0f)
          curveToRelative(-0.55f, 0.0f, -1.0f, -0.45f, -1.0f, -1.0f)
          verticalLineTo(7.0f)
          curveToRelative(0.0f, -1.65f, -1.35f, -3.0f, -3.0f, -3.0f)
          horizontalLineToRelative(-3.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(3.0f)
          curveToRelative(0.55f, 0.0f, 1.0f, 0.45f, 1.0f, 1.0f)
          verticalLineToRelative(2.0f)
          curveToRelative(0.0f, 1.3f, 0.84f, 2.42f, 2.0f, 2.83f)
          verticalLineToRelative(0.34f)
          curveToRelative(-1.16f, 0.41f, -2.0f, 1.52f, -2.0f, 2.83f)
          verticalLineToRelative(2.0f)
          curveToRelative(0.0f, 0.55f, -0.45f, 1.0f, -1.0f, 1.0f)
          horizontalLineToRelative(-3.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(3.0f)
          curveToRelative(1.65f, 0.0f, 3.0f, -1.35f, 3.0f, -3.0f)
          verticalLineToRelative(-2.0f)
          curveToRelative(0.0f, -0.55f, 0.45f, -1.0f, 1.0f, -1.0f)
          horizontalLineToRelative(1.0f)
          verticalLineToRelative(-4.0f)
          horizontalLineTo(21.0f)
          close()
        }
      }
    return cachedDataObject!!
  }

private var cachedDataObject: ImageVector? = null
