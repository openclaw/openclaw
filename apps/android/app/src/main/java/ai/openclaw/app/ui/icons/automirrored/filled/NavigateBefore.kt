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

package ai.openclaw.app.ui.icons.automirrored.filled

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.ui.graphics.vector.ImageVector

public val Icons.AutoMirrored.Filled.NavigateBefore: ImageVector
  get() {
    if (cachedNavigateBefore != null) {
      return cachedNavigateBefore!!
    }
    cachedNavigateBefore =
      materialIcon(
        name = "AutoMirrored.Filled.NavigateBefore",
        autoMirror = true,
      ) {
        materialPath {
          moveTo(15.41f, 7.41f)
          lineTo(14.0f, 6.0f)
          lineToRelative(-6.0f, 6.0f)
          lineToRelative(6.0f, 6.0f)
          lineToRelative(1.41f, -1.41f)
          lineTo(10.83f, 12.0f)
          close()
        }
      }
    return cachedNavigateBefore!!
  }

private var cachedNavigateBefore: ImageVector? = null
