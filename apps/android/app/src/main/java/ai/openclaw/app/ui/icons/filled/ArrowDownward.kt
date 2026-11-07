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

public val Icons.Filled.ArrowDownward: ImageVector
  get() {
    if (cachedArrowDownward != null) {
      return cachedArrowDownward!!
    }
    cachedArrowDownward =
      materialIcon(name = "Filled.ArrowDownward") {
        materialPath {
          moveTo(20.0f, 12.0f)
          lineToRelative(-1.41f, -1.41f)
          lineTo(13.0f, 16.17f)
          verticalLineTo(4.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(12.17f)
          lineToRelative(-5.58f, -5.59f)
          lineTo(4.0f, 12.0f)
          lineToRelative(8.0f, 8.0f)
          lineToRelative(8.0f, -8.0f)
          close()
        }
      }
    return cachedArrowDownward!!
  }

private var cachedArrowDownward: ImageVector? = null
