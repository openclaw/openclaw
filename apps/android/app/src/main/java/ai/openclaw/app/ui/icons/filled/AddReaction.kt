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

public val Icons.Filled.AddReaction: ImageVector
  get() {
    if (cachedAddReaction != null) {
      return cachedAddReaction!!
    }
    cachedAddReaction =
      materialIcon(name = "Filled.AddReaction") {
        materialPath {
          moveTo(18.0f, 9.0f)
          verticalLineTo(7.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineTo(2.84f)
          curveTo(14.77f, 2.3f, 13.42f, 2.0f, 11.99f, 2.0f)
          curveTo(6.47f, 2.0f, 2.0f, 6.48f, 2.0f, 12.0f)
          reflectiveCurveToRelative(4.47f, 10.0f, 9.99f, 10.0f)
          curveTo(17.52f, 22.0f, 22.0f, 17.52f, 22.0f, 12.0f)
          curveToRelative(0.0f, -1.05f, -0.17f, -2.05f, -0.47f, -3.0f)
          horizontalLineTo(18.0f)
          close()
          moveTo(15.5f, 8.0f)
          curveTo(16.33f, 8.0f, 17.0f, 8.67f, 17.0f, 9.5f)
          reflectiveCurveTo(16.33f, 11.0f, 15.5f, 11.0f)
          reflectiveCurveTo(14.0f, 10.33f, 14.0f, 9.5f)
          reflectiveCurveTo(14.67f, 8.0f, 15.5f, 8.0f)
          close()
          moveTo(8.5f, 8.0f)
          curveTo(9.33f, 8.0f, 10.0f, 8.67f, 10.0f, 9.5f)
          reflectiveCurveTo(9.33f, 11.0f, 8.5f, 11.0f)
          reflectiveCurveTo(7.0f, 10.33f, 7.0f, 9.5f)
          reflectiveCurveTo(7.67f, 8.0f, 8.5f, 8.0f)
          close()
          moveTo(12.0f, 17.5f)
          curveToRelative(-2.33f, 0.0f, -4.31f, -1.46f, -5.11f, -3.5f)
          horizontalLineToRelative(10.22f)
          curveTo(16.31f, 16.04f, 14.33f, 17.5f, 12.0f, 17.5f)
          close()
          moveTo(22.0f, 3.0f)
          horizontalLineToRelative(2.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineToRelative(2.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineTo(5.0f)
          horizontalLineToRelative(-2.0f)
          verticalLineTo(3.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(1.0f)
          horizontalLineToRelative(2.0f)
          verticalLineTo(3.0f)
          close()
        }
      }
    return cachedAddReaction!!
  }

private var cachedAddReaction: ImageVector? = null
