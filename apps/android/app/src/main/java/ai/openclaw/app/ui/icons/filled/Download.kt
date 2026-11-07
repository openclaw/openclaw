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

public val Icons.Filled.Download: ImageVector
  get() {
    if (cachedDownload != null) {
      return cachedDownload!!
    }
    cachedDownload =
      materialIcon(name = "Filled.Download") {
        materialPath {
          moveTo(5.0f, 20.0f)
          horizontalLineToRelative(14.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineTo(5.0f)
          verticalLineTo(20.0f)
          close()
          moveTo(19.0f, 9.0f)
          horizontalLineToRelative(-4.0f)
          verticalLineTo(3.0f)
          horizontalLineTo(9.0f)
          verticalLineToRelative(6.0f)
          horizontalLineTo(5.0f)
          lineToRelative(7.0f, 7.0f)
          lineTo(19.0f, 9.0f)
          close()
        }
      }
    return cachedDownload!!
  }

private var cachedDownload: ImageVector? = null
