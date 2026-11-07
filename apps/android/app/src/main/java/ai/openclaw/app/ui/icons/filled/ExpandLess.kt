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

public val Icons.Filled.ExpandLess: ImageVector
  get() {
    if (cachedExpandLess != null) {
      return cachedExpandLess!!
    }
    cachedExpandLess =
      materialIcon(name = "Filled.ExpandLess") {
        materialPath {
          moveTo(12.0f, 8.0f)
          lineToRelative(-6.0f, 6.0f)
          lineToRelative(1.41f, 1.41f)
          lineTo(12.0f, 10.83f)
          lineToRelative(4.59f, 4.58f)
          lineTo(18.0f, 14.0f)
          close()
        }
      }
    return cachedExpandLess!!
  }

private var cachedExpandLess: ImageVector? = null
