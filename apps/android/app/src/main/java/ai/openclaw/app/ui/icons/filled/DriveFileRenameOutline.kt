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

public val Icons.Filled.DriveFileRenameOutline: ImageVector
  get() {
    if (cachedDriveFileRenameOutline != null) {
      return cachedDriveFileRenameOutline!!
    }
    cachedDriveFileRenameOutline =
      materialIcon(name = "Filled.DriveFileRenameOutline") {
        materialPath {
          moveTo(18.41f, 5.8f)
          lineTo(17.2f, 4.59f)
          curveToRelative(-0.78f, -0.78f, -2.05f, -0.78f, -2.83f, 0.0f)
          lineToRelative(-2.68f, 2.68f)
          lineTo(3.0f, 15.96f)
          verticalLineTo(20.0f)
          horizontalLineToRelative(4.04f)
          lineToRelative(8.74f, -8.74f)
          lineToRelative(2.63f, -2.63f)
          curveToRelative(0.79f, -0.78f, 0.79f, -2.05f, 0.0f, -2.83f)
          close()
          moveTo(6.21f, 18.0f)
          horizontalLineTo(5.0f)
          verticalLineToRelative(-1.21f)
          lineToRelative(8.66f, -8.66f)
          lineToRelative(1.21f, 1.21f)
          lineTo(6.21f, 18.0f)
          close()
          moveTo(11.0f, 20.0f)
          lineToRelative(4.0f, -4.0f)
          horizontalLineToRelative(6.0f)
          verticalLineToRelative(4.0f)
          horizontalLineTo(11.0f)
          close()
        }
      }
    return cachedDriveFileRenameOutline!!
  }

private var cachedDriveFileRenameOutline: ImageVector? = null
