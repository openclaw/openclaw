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

public val Icons.Filled.Layers: ImageVector
  get() {
    if (cachedLayers != null) {
      return cachedLayers!!
    }
    cachedLayers =
      materialIcon(name = "Filled.Layers") {
        materialPath {
          moveTo(11.99f, 18.54f)
          lineToRelative(-7.37f, -5.73f)
          lineTo(3.0f, 14.07f)
          lineToRelative(9.0f, 7.0f)
          lineToRelative(9.0f, -7.0f)
          lineToRelative(-1.63f, -1.27f)
          lineToRelative(-7.38f, 5.74f)
          close()
          moveTo(12.0f, 16.0f)
          lineToRelative(7.36f, -5.73f)
          lineTo(21.0f, 9.0f)
          lineToRelative(-9.0f, -7.0f)
          lineToRelative(-9.0f, 7.0f)
          lineToRelative(1.63f, 1.27f)
          lineTo(12.0f, 16.0f)
          close()
        }
      }
    return cachedLayers!!
  }

private var cachedLayers: ImageVector? = null
