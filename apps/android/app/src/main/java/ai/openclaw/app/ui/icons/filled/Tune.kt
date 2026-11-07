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

public val Icons.Filled.Tune: ImageVector
  get() {
    if (cachedTune != null) {
      return cachedTune!!
    }
    cachedTune =
      materialIcon(name = "Filled.Tune") {
        materialPath {
          moveTo(3.0f, 17.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(6.0f)
          verticalLineToRelative(-2.0f)
          lineTo(3.0f, 17.0f)
          close()
          moveTo(3.0f, 5.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(10.0f)
          lineTo(13.0f, 5.0f)
          lineTo(3.0f, 5.0f)
          close()
          moveTo(13.0f, 21.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(8.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(-8.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(6.0f)
          horizontalLineToRelative(2.0f)
          close()
          moveTo(7.0f, 9.0f)
          verticalLineToRelative(2.0f)
          lineTo(3.0f, 11.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(4.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(2.0f)
          lineTo(9.0f, 9.0f)
          lineTo(7.0f, 9.0f)
          close()
          moveTo(21.0f, 13.0f)
          verticalLineToRelative(-2.0f)
          lineTo(11.0f, 11.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(10.0f)
          close()
          moveTo(15.0f, 9.0f)
          horizontalLineToRelative(2.0f)
          lineTo(17.0f, 7.0f)
          horizontalLineToRelative(4.0f)
          lineTo(21.0f, 5.0f)
          horizontalLineToRelative(-4.0f)
          lineTo(17.0f, 3.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(6.0f)
          close()
        }
      }
    return cachedTune!!
  }

private var cachedTune: ImageVector? = null
