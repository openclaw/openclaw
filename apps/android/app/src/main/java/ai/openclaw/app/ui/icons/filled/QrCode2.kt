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

public val Icons.Filled.QrCode2: ImageVector
  get() {
    if (cachedQrCode2 != null) {
      return cachedQrCode2!!
    }
    cachedQrCode2 =
      materialIcon(name = "Filled.QrCode2") {
        materialPath {
          moveTo(15.0f, 21.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(21.0f)
          close()
          moveTo(13.0f, 14.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(5.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(14.0f)
          close()
          moveTo(21.0f, 12.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(4.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(12.0f)
          close()
          moveTo(19.0f, 10.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(10.0f)
          close()
          moveTo(7.0f, 12.0f)
          horizontalLineTo(5.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(12.0f)
          close()
          moveTo(5.0f, 10.0f)
          horizontalLineTo(3.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(10.0f)
          close()
          moveTo(12.0f, 5.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(3.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineTo(5.0f)
          close()
          moveTo(4.5f, 4.5f)
          verticalLineToRelative(3.0f)
          horizontalLineToRelative(3.0f)
          verticalLineToRelative(-3.0f)
          horizontalLineTo(4.5f)
          close()
          moveTo(9.0f, 9.0f)
          horizontalLineTo(3.0f)
          verticalLineTo(3.0f)
          horizontalLineToRelative(6.0f)
          verticalLineTo(9.0f)
          close()
          moveTo(4.5f, 16.5f)
          verticalLineToRelative(3.0f)
          horizontalLineToRelative(3.0f)
          verticalLineToRelative(-3.0f)
          horizontalLineTo(4.5f)
          close()
          moveTo(9.0f, 21.0f)
          horizontalLineTo(3.0f)
          verticalLineToRelative(-6.0f)
          horizontalLineToRelative(6.0f)
          verticalLineTo(21.0f)
          close()
          moveTo(16.5f, 4.5f)
          verticalLineToRelative(3.0f)
          horizontalLineToRelative(3.0f)
          verticalLineToRelative(-3.0f)
          horizontalLineTo(16.5f)
          close()
          moveTo(21.0f, 9.0f)
          horizontalLineToRelative(-6.0f)
          verticalLineTo(3.0f)
          horizontalLineToRelative(6.0f)
          verticalLineTo(9.0f)
          close()
          moveTo(19.0f, 19.0f)
          verticalLineToRelative(-3.0f)
          lineToRelative(-4.0f, 0.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(3.0f)
          horizontalLineToRelative(4.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineTo(19.0f)
          close()
          moveTo(17.0f, 12.0f)
          lineToRelative(-4.0f, 0.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(4.0f)
          verticalLineTo(12.0f)
          close()
          moveTo(13.0f, 10.0f)
          horizontalLineTo(7.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(-2.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(10.0f)
          close()
          moveTo(14.0f, 9.0f)
          verticalLineTo(7.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineTo(5.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(4.0f)
          lineTo(14.0f, 9.0f)
          close()
          moveTo(6.75f, 5.25f)
          horizontalLineToRelative(-1.5f)
          verticalLineToRelative(1.5f)
          horizontalLineToRelative(1.5f)
          verticalLineTo(5.25f)
          close()
          moveTo(6.75f, 17.25f)
          horizontalLineToRelative(-1.5f)
          verticalLineToRelative(1.5f)
          horizontalLineToRelative(1.5f)
          verticalLineTo(17.25f)
          close()
          moveTo(18.75f, 5.25f)
          horizontalLineToRelative(-1.5f)
          verticalLineToRelative(1.5f)
          horizontalLineToRelative(1.5f)
          verticalLineTo(5.25f)
          close()
        }
      }
    return cachedQrCode2!!
  }

private var cachedQrCode2: ImageVector? = null
