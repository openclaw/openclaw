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

public val Icons.Filled.Cloud: ImageVector
  get() {
    if (cachedCloud != null) {
      return cachedCloud!!
    }
    cachedCloud =
      materialIcon(name = "Filled.Cloud") {
        materialPath {
          moveTo(19.35f, 10.04f)
          curveTo(18.67f, 6.59f, 15.64f, 4.0f, 12.0f, 4.0f)
          curveTo(9.11f, 4.0f, 6.6f, 5.64f, 5.35f, 8.04f)
          curveTo(2.34f, 8.36f, 0.0f, 10.91f, 0.0f, 14.0f)
          curveToRelative(0.0f, 3.31f, 2.69f, 6.0f, 6.0f, 6.0f)
          horizontalLineToRelative(13.0f)
          curveToRelative(2.76f, 0.0f, 5.0f, -2.24f, 5.0f, -5.0f)
          curveToRelative(0.0f, -2.64f, -2.05f, -4.78f, -4.65f, -4.96f)
          close()
        }
      }
    return cachedCloud!!
  }

private var cachedCloud: ImageVector? = null
