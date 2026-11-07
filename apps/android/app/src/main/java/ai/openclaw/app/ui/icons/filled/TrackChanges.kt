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

public val Icons.Filled.TrackChanges: ImageVector
  get() {
    if (cachedTrackChanges != null) {
      return cachedTrackChanges!!
    }
    cachedTrackChanges =
      materialIcon(name = "Filled.TrackChanges") {
        materialPath {
          moveTo(19.07f, 4.93f)
          lineToRelative(-1.41f, 1.41f)
          curveTo(19.1f, 7.79f, 20.0f, 9.79f, 20.0f, 12.0f)
          curveToRelative(0.0f, 4.42f, -3.58f, 8.0f, -8.0f, 8.0f)
          reflectiveCurveToRelative(-8.0f, -3.58f, -8.0f, -8.0f)
          curveToRelative(0.0f, -4.08f, 3.05f, -7.44f, 7.0f, -7.93f)
          verticalLineToRelative(2.02f)
          curveTo(8.16f, 6.57f, 6.0f, 9.03f, 6.0f, 12.0f)
          curveToRelative(0.0f, 3.31f, 2.69f, 6.0f, 6.0f, 6.0f)
          reflectiveCurveToRelative(6.0f, -2.69f, 6.0f, -6.0f)
          curveToRelative(0.0f, -1.66f, -0.67f, -3.16f, -1.76f, -4.24f)
          lineToRelative(-1.41f, 1.41f)
          curveTo(15.55f, 9.9f, 16.0f, 10.9f, 16.0f, 12.0f)
          curveToRelative(0.0f, 2.21f, -1.79f, 4.0f, -4.0f, 4.0f)
          reflectiveCurveToRelative(-4.0f, -1.79f, -4.0f, -4.0f)
          curveToRelative(0.0f, -1.86f, 1.28f, -3.41f, 3.0f, -3.86f)
          verticalLineToRelative(2.14f)
          curveToRelative(-0.6f, 0.35f, -1.0f, 0.98f, -1.0f, 1.72f)
          curveToRelative(0.0f, 1.1f, 0.9f, 2.0f, 2.0f, 2.0f)
          reflectiveCurveToRelative(2.0f, -0.9f, 2.0f, -2.0f)
          curveToRelative(0.0f, -0.74f, -0.4f, -1.38f, -1.0f, -1.72f)
          verticalLineTo(2.0f)
          horizontalLineToRelative(-1.0f)
          curveTo(6.48f, 2.0f, 2.0f, 6.48f, 2.0f, 12.0f)
          reflectiveCurveToRelative(4.48f, 10.0f, 10.0f, 10.0f)
          reflectiveCurveToRelative(10.0f, -4.48f, 10.0f, -10.0f)
          curveToRelative(0.0f, -2.76f, -1.12f, -5.26f, -2.93f, -7.07f)
          close()
        }
      }
    return cachedTrackChanges!!
  }

private var cachedTrackChanges: ImageVector? = null
