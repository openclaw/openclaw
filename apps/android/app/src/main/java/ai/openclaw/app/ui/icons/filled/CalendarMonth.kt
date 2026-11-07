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

public val Icons.Filled.CalendarMonth: ImageVector
  get() {
    if (cachedCalendarMonth != null) {
      return cachedCalendarMonth!!
    }
    cachedCalendarMonth =
      materialIcon(name = "Filled.CalendarMonth") {
        materialPath {
          moveTo(19.0f, 4.0f)
          horizontalLineToRelative(-1.0f)
          verticalLineTo(2.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(2.0f)
          horizontalLineTo(8.0f)
          verticalLineTo(2.0f)
          horizontalLineTo(6.0f)
          verticalLineToRelative(2.0f)
          horizontalLineTo(5.0f)
          curveTo(3.89f, 4.0f, 3.01f, 4.9f, 3.01f, 6.0f)
          lineTo(3.0f, 20.0f)
          curveToRelative(0.0f, 1.1f, 0.89f, 2.0f, 2.0f, 2.0f)
          horizontalLineToRelative(14.0f)
          curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
          verticalLineTo(6.0f)
          curveTo(21.0f, 4.9f, 20.1f, 4.0f, 19.0f, 4.0f)
          close()
          moveTo(19.0f, 20.0f)
          horizontalLineTo(5.0f)
          verticalLineTo(10.0f)
          horizontalLineToRelative(14.0f)
          verticalLineTo(20.0f)
          close()
          moveTo(9.0f, 14.0f)
          horizontalLineTo(7.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(14.0f)
          close()
          moveTo(13.0f, 14.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(14.0f)
          close()
          moveTo(17.0f, 14.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(14.0f)
          close()
          moveTo(9.0f, 18.0f)
          horizontalLineTo(7.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(18.0f)
          close()
          moveTo(13.0f, 18.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(18.0f)
          close()
          moveTo(17.0f, 18.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(18.0f)
          close()
        }
      }
    return cachedCalendarMonth!!
  }

private var cachedCalendarMonth: ImageVector? = null
