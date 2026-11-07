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
import androidx.compose.ui.graphics.PathFillType.Companion.EvenOdd
import androidx.compose.ui.graphics.vector.ImageVector

public val Icons.Filled.PushPin: ImageVector
  get() {
    if (cachedPushPin != null) {
      return cachedPushPin!!
    }
    cachedPushPin =
      materialIcon(name = "Filled.PushPin") {
        materialPath(pathFillType = EvenOdd) {
          moveTo(16.0f, 9.0f)
          verticalLineTo(4.0f)
          lineToRelative(1.0f, 0.0f)
          curveToRelative(0.55f, 0.0f, 1.0f, -0.45f, 1.0f, -1.0f)
          verticalLineToRelative(0.0f)
          curveToRelative(0.0f, -0.55f, -0.45f, -1.0f, -1.0f, -1.0f)
          horizontalLineTo(7.0f)
          curveTo(6.45f, 2.0f, 6.0f, 2.45f, 6.0f, 3.0f)
          verticalLineToRelative(0.0f)
          curveToRelative(0.0f, 0.55f, 0.45f, 1.0f, 1.0f, 1.0f)
          lineToRelative(1.0f, 0.0f)
          verticalLineToRelative(5.0f)
          curveToRelative(0.0f, 1.66f, -1.34f, 3.0f, -3.0f, 3.0f)
          horizontalLineToRelative(0.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(5.97f)
          verticalLineToRelative(7.0f)
          lineToRelative(1.0f, 1.0f)
          lineToRelative(1.0f, -1.0f)
          verticalLineToRelative(-7.0f)
          horizontalLineTo(19.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(0.0f)
          curveTo(17.34f, 12.0f, 16.0f, 10.66f, 16.0f, 9.0f)
          close()
        }
      }
    return cachedPushPin!!
  }

private var cachedPushPin: ImageVector? = null
