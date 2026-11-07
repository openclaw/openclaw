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

public val Icons.Filled.Policy: ImageVector
  get() {
    if (cachedPolicy != null) {
      return cachedPolicy!!
    }
    cachedPolicy =
      materialIcon(name = "Filled.Policy") {
        materialPath {
          moveTo(21.0f, 5.0f)
          lineToRelative(-9.0f, -4.0f)
          lineTo(3.0f, 5.0f)
          verticalLineToRelative(6.0f)
          curveToRelative(0.0f, 5.55f, 3.84f, 10.74f, 9.0f, 12.0f)
          curveToRelative(2.3f, -0.56f, 4.33f, -1.9f, 5.88f, -3.71f)
          lineToRelative(-3.12f, -3.12f)
          curveToRelative(-1.94f, 1.29f, -4.58f, 1.07f, -6.29f, -0.64f)
          curveToRelative(-1.95f, -1.95f, -1.95f, -5.12f, 0.0f, -7.07f)
          curveToRelative(1.95f, -1.95f, 5.12f, -1.95f, 7.07f, 0.0f)
          curveToRelative(1.71f, 1.71f, 1.92f, 4.35f, 0.64f, 6.29f)
          lineToRelative(2.9f, 2.9f)
          curveTo(20.29f, 15.69f, 21.0f, 13.38f, 21.0f, 11.0f)
          verticalLineTo(5.0f)
          close()
        }
        materialPath {
          moveTo(12.0f, 12.0f)
          moveToRelative(-3.0f, 0.0f)
          arcToRelative(3.0f, 3.0f, 0.0f, true, true, 6.0f, 0.0f)
          arcToRelative(3.0f, 3.0f, 0.0f, true, true, -6.0f, 0.0f)
        }
      }
    return cachedPolicy!!
  }

private var cachedPolicy: ImageVector? = null
