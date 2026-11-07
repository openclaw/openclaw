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

public val Icons.Outlined.Dashboard: ImageVector
  get() {
    if (cachedDashboard != null) {
      return cachedDashboard!!
    }
    cachedDashboard =
      materialIcon(name = "Outlined.Dashboard") {
        materialPath {
          moveTo(19.0f, 5.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(-4.0f)
          lineTo(15.0f, 5.0f)
          horizontalLineToRelative(4.0f)
          moveTo(9.0f, 5.0f)
          verticalLineToRelative(6.0f)
          lineTo(5.0f, 11.0f)
          lineTo(5.0f, 5.0f)
          horizontalLineToRelative(4.0f)
          moveToRelative(10.0f, 8.0f)
          verticalLineToRelative(6.0f)
          horizontalLineToRelative(-4.0f)
          verticalLineToRelative(-6.0f)
          horizontalLineToRelative(4.0f)
          moveTo(9.0f, 17.0f)
          verticalLineToRelative(2.0f)
          lineTo(5.0f, 19.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(4.0f)
          moveTo(21.0f, 3.0f)
          horizontalLineToRelative(-8.0f)
          verticalLineToRelative(6.0f)
          horizontalLineToRelative(8.0f)
          lineTo(21.0f, 3.0f)
          close()
          moveTo(11.0f, 3.0f)
          lineTo(3.0f, 3.0f)
          verticalLineToRelative(10.0f)
          horizontalLineToRelative(8.0f)
          lineTo(11.0f, 3.0f)
          close()
          moveTo(21.0f, 11.0f)
          horizontalLineToRelative(-8.0f)
          verticalLineToRelative(10.0f)
          horizontalLineToRelative(8.0f)
          lineTo(21.0f, 11.0f)
          close()
          moveTo(11.0f, 15.0f)
          lineTo(3.0f, 15.0f)
          verticalLineToRelative(6.0f)
          horizontalLineToRelative(8.0f)
          verticalLineToRelative(-6.0f)
          close()
        }
      }
    return cachedDashboard!!
  }

private var cachedDashboard: ImageVector? = null
