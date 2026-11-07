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

public val Icons.Filled.Checklist: ImageVector
  get() {
    if (cachedChecklist != null) {
      return cachedChecklist!!
    }
    cachedChecklist =
      materialIcon(name = "Filled.Checklist") {
        materialPath {
          moveTo(22.0f, 7.0f)
          horizontalLineToRelative(-9.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(9.0f)
          verticalLineTo(7.0f)
          close()
          moveTo(22.0f, 15.0f)
          horizontalLineToRelative(-9.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(9.0f)
          verticalLineTo(15.0f)
          close()
          moveTo(5.54f, 11.0f)
          lineTo(2.0f, 7.46f)
          lineToRelative(1.41f, -1.41f)
          lineToRelative(2.12f, 2.12f)
          lineToRelative(4.24f, -4.24f)
          lineToRelative(1.41f, 1.41f)
          lineTo(5.54f, 11.0f)
          close()
          moveTo(5.54f, 19.0f)
          lineTo(2.0f, 15.46f)
          lineToRelative(1.41f, -1.41f)
          lineToRelative(2.12f, 2.12f)
          lineToRelative(4.24f, -4.24f)
          lineToRelative(1.41f, 1.41f)
          lineTo(5.54f, 19.0f)
          close()
        }
      }
    return cachedChecklist!!
  }

private var cachedChecklist: ImageVector? = null
