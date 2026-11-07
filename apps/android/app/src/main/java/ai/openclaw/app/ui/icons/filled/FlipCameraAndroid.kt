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

public val Icons.Filled.FlipCameraAndroid: ImageVector
  get() {
    if (cachedFlipCameraAndroid != null) {
      return cachedFlipCameraAndroid!!
    }
    cachedFlipCameraAndroid =
      materialIcon(name = "Filled.FlipCameraAndroid") {
        materialPath {
          moveTo(9.0f, 12.0f)
          curveToRelative(0.0f, 1.66f, 1.34f, 3.0f, 3.0f, 3.0f)
          reflectiveCurveToRelative(3.0f, -1.34f, 3.0f, -3.0f)
          reflectiveCurveToRelative(-1.34f, -3.0f, -3.0f, -3.0f)
          reflectiveCurveTo(9.0f, 10.34f, 9.0f, 12.0f)
          close()
        }
        materialPath {
          moveTo(8.0f, 10.0f)
          verticalLineTo(8.0f)
          horizontalLineTo(5.09f)
          curveTo(6.47f, 5.61f, 9.05f, 4.0f, 12.0f, 4.0f)
          curveToRelative(3.72f, 0.0f, 6.85f, 2.56f, 7.74f, 6.0f)
          horizontalLineToRelative(2.06f)
          curveToRelative(-0.93f, -4.56f, -4.96f, -8.0f, -9.8f, -8.0f)
          curveTo(8.73f, 2.0f, 5.82f, 3.58f, 4.0f, 6.01f)
          verticalLineTo(4.0f)
          horizontalLineTo(2.0f)
          verticalLineToRelative(6.0f)
          horizontalLineTo(8.0f)
          close()
        }
        materialPath {
          moveTo(16.0f, 14.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(2.91f)
          curveToRelative(-1.38f, 2.39f, -3.96f, 4.0f, -6.91f, 4.0f)
          curveToRelative(-3.72f, 0.0f, -6.85f, -2.56f, -7.74f, -6.0f)
          horizontalLineTo(2.2f)
          curveToRelative(0.93f, 4.56f, 4.96f, 8.0f, 9.8f, 8.0f)
          curveToRelative(3.27f, 0.0f, 6.18f, -1.58f, 8.0f, -4.01f)
          verticalLineTo(20.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(-6.0f)
          horizontalLineTo(16.0f)
          close()
        }
      }
    return cachedFlipCameraAndroid!!
  }

private var cachedFlipCameraAndroid: ImageVector? = null
