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

public val Icons.Filled.GraphicEq: ImageVector
  get() {
    if (cachedGraphicEq != null) {
      return cachedGraphicEq!!
    }
    cachedGraphicEq =
      materialIcon(name = "Filled.GraphicEq") {
        materialPath {
          moveTo(7.0f, 18.0f)
          horizontalLineToRelative(2.0f)
          lineTo(9.0f, 6.0f)
          lineTo(7.0f, 6.0f)
          verticalLineToRelative(12.0f)
          close()
          moveTo(11.0f, 22.0f)
          horizontalLineToRelative(2.0f)
          lineTo(13.0f, 2.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(20.0f)
          close()
          moveTo(3.0f, 14.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(-4.0f)
          lineTo(3.0f, 10.0f)
          verticalLineToRelative(4.0f)
          close()
          moveTo(15.0f, 18.0f)
          horizontalLineToRelative(2.0f)
          lineTo(17.0f, 6.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(12.0f)
          close()
          moveTo(19.0f, 10.0f)
          verticalLineToRelative(4.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(-4.0f)
          horizontalLineToRelative(-2.0f)
          close()
        }
      }
    return cachedGraphicEq!!
  }

private var cachedGraphicEq: ImageVector? = null
