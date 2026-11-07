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

public val Icons.Filled.Extension: ImageVector
  get() {
    if (cachedExtension != null) {
      return cachedExtension!!
    }
    cachedExtension =
      materialIcon(name = "Filled.Extension") {
        materialPath {
          moveTo(20.5f, 11.0f)
          horizontalLineTo(19.0f)
          verticalLineTo(7.0f)
          curveToRelative(0.0f, -1.1f, -0.9f, -2.0f, -2.0f, -2.0f)
          horizontalLineToRelative(-4.0f)
          verticalLineTo(3.5f)
          curveTo(13.0f, 2.12f, 11.88f, 1.0f, 10.5f, 1.0f)
          reflectiveCurveTo(8.0f, 2.12f, 8.0f, 3.5f)
          verticalLineTo(5.0f)
          horizontalLineTo(4.0f)
          curveToRelative(-1.1f, 0.0f, -1.99f, 0.9f, -1.99f, 2.0f)
          verticalLineToRelative(3.8f)
          horizontalLineTo(3.5f)
          curveToRelative(1.49f, 0.0f, 2.7f, 1.21f, 2.7f, 2.7f)
          reflectiveCurveToRelative(-1.21f, 2.7f, -2.7f, 2.7f)
          horizontalLineTo(2.0f)
          verticalLineTo(20.0f)
          curveToRelative(0.0f, 1.1f, 0.9f, 2.0f, 2.0f, 2.0f)
          horizontalLineToRelative(3.8f)
          verticalLineToRelative(-1.5f)
          curveToRelative(0.0f, -1.49f, 1.21f, -2.7f, 2.7f, -2.7f)
          curveToRelative(1.49f, 0.0f, 2.7f, 1.21f, 2.7f, 2.7f)
          verticalLineTo(22.0f)
          horizontalLineTo(17.0f)
          curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
          verticalLineToRelative(-4.0f)
          horizontalLineToRelative(1.5f)
          curveToRelative(1.38f, 0.0f, 2.5f, -1.12f, 2.5f, -2.5f)
          reflectiveCurveTo(21.88f, 11.0f, 20.5f, 11.0f)
          close()
        }
      }
    return cachedExtension!!
  }

private var cachedExtension: ImageVector? = null
