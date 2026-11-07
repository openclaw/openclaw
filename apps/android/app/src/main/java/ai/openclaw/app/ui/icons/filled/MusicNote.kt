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

public val Icons.Filled.MusicNote: ImageVector
  get() {
    if (cachedMusicNote != null) {
      return cachedMusicNote!!
    }
    cachedMusicNote =
      materialIcon(name = "Filled.MusicNote") {
        materialPath {
          moveTo(12.0f, 3.0f)
          verticalLineToRelative(10.55f)
          curveToRelative(-0.59f, -0.34f, -1.27f, -0.55f, -2.0f, -0.55f)
          curveToRelative(-2.21f, 0.0f, -4.0f, 1.79f, -4.0f, 4.0f)
          reflectiveCurveToRelative(1.79f, 4.0f, 4.0f, 4.0f)
          reflectiveCurveToRelative(4.0f, -1.79f, 4.0f, -4.0f)
          verticalLineTo(7.0f)
          horizontalLineToRelative(4.0f)
          verticalLineTo(3.0f)
          horizontalLineToRelative(-6.0f)
          close()
        }
      }
    return cachedMusicNote!!
  }

private var cachedMusicNote: ImageVector? = null
