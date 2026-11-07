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

public val Icons.Filled.AutoAwesome: ImageVector
  get() {
    if (cachedAutoAwesome != null) {
      return cachedAutoAwesome!!
    }
    cachedAutoAwesome =
      materialIcon(name = "Filled.AutoAwesome") {
        materialPath {
          moveTo(19.0f, 9.0f)
          lineToRelative(1.25f, -2.75f)
          lineTo(23.0f, 5.0f)
          lineToRelative(-2.75f, -1.25f)
          lineTo(19.0f, 1.0f)
          lineToRelative(-1.25f, 2.75f)
          lineTo(15.0f, 5.0f)
          lineToRelative(2.75f, 1.25f)
          lineTo(19.0f, 9.0f)
          close()
          moveTo(11.5f, 9.5f)
          lineTo(9.0f, 4.0f)
          lineTo(6.5f, 9.5f)
          lineTo(1.0f, 12.0f)
          lineToRelative(5.5f, 2.5f)
          lineTo(9.0f, 20.0f)
          lineToRelative(2.5f, -5.5f)
          lineTo(17.0f, 12.0f)
          lineToRelative(-5.5f, -2.5f)
          close()
          moveTo(19.0f, 15.0f)
          lineToRelative(-1.25f, 2.75f)
          lineTo(15.0f, 19.0f)
          lineToRelative(2.75f, 1.25f)
          lineTo(19.0f, 23.0f)
          lineToRelative(1.25f, -2.75f)
          lineTo(23.0f, 19.0f)
          lineToRelative(-2.75f, -1.25f)
          lineTo(19.0f, 15.0f)
          close()
        }
      }
    return cachedAutoAwesome!!
  }

private var cachedAutoAwesome: ImageVector? = null
