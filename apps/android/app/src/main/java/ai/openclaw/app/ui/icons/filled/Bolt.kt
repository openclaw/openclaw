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

public val Icons.Filled.Bolt: ImageVector
  get() {
    if (cachedBolt != null) {
      return cachedBolt!!
    }
    cachedBolt =
      materialIcon(name = "Filled.Bolt") {
        materialPath {
          moveTo(11.0f, 21.0f)
          horizontalLineToRelative(-1.0f)
          lineToRelative(1.0f, -7.0f)
          horizontalLineTo(7.5f)
          curveToRelative(-0.58f, 0.0f, -0.57f, -0.32f, -0.38f, -0.66f)
          curveToRelative(0.19f, -0.34f, 0.05f, -0.08f, 0.07f, -0.12f)
          curveTo(8.48f, 10.94f, 10.42f, 7.54f, 13.0f, 3.0f)
          horizontalLineToRelative(1.0f)
          lineToRelative(-1.0f, 7.0f)
          horizontalLineToRelative(3.5f)
          curveToRelative(0.49f, 0.0f, 0.56f, 0.33f, 0.47f, 0.51f)
          lineToRelative(-0.07f, 0.15f)
          curveTo(12.96f, 17.55f, 11.0f, 21.0f, 11.0f, 21.0f)
          close()
        }
      }
    return cachedBolt!!
  }

private var cachedBolt: ImageVector? = null
