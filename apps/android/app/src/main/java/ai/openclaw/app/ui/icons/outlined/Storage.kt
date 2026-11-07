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

package ai.openclaw.app.ui.icons.outlined

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.ui.graphics.vector.ImageVector

public val Icons.Outlined.Storage: ImageVector
  get() {
    if (cachedStorage != null) {
      return cachedStorage!!
    }
    cachedStorage =
      materialIcon(name = "Outlined.Storage") {
        materialPath {
          moveTo(2.0f, 20.0f)
          horizontalLineToRelative(20.0f)
          verticalLineToRelative(-4.0f)
          lineTo(2.0f, 16.0f)
          verticalLineToRelative(4.0f)
          close()
          moveTo(4.0f, 17.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(2.0f)
          lineTo(4.0f, 19.0f)
          verticalLineToRelative(-2.0f)
          close()
          moveTo(2.0f, 4.0f)
          verticalLineToRelative(4.0f)
          horizontalLineToRelative(20.0f)
          lineTo(22.0f, 4.0f)
          lineTo(2.0f, 4.0f)
          close()
          moveTo(6.0f, 7.0f)
          lineTo(4.0f, 7.0f)
          lineTo(4.0f, 5.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(2.0f)
          close()
          moveTo(2.0f, 14.0f)
          horizontalLineToRelative(20.0f)
          verticalLineToRelative(-4.0f)
          lineTo(2.0f, 10.0f)
          verticalLineToRelative(4.0f)
          close()
          moveTo(4.0f, 11.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(2.0f)
          lineTo(4.0f, 13.0f)
          verticalLineToRelative(-2.0f)
          close()
        }
      }
    return cachedStorage!!
  }

private var cachedStorage: ImageVector? = null
