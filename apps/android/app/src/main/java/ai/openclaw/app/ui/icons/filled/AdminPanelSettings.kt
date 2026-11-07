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

public val Icons.Filled.AdminPanelSettings: ImageVector
  get() {
    if (cachedAdminPanelSettings != null) {
      return cachedAdminPanelSettings!!
    }
    cachedAdminPanelSettings =
      materialIcon(name = "Filled.AdminPanelSettings") {
        materialPath {
          moveTo(17.0f, 11.0f)
          curveToRelative(0.34f, 0.0f, 0.67f, 0.04f, 1.0f, 0.09f)
          verticalLineTo(6.27f)
          lineTo(10.5f, 3.0f)
          lineTo(3.0f, 6.27f)
          verticalLineToRelative(4.91f)
          curveToRelative(0.0f, 4.54f, 3.2f, 8.79f, 7.5f, 9.82f)
          curveToRelative(0.55f, -0.13f, 1.08f, -0.32f, 1.6f, -0.55f)
          curveTo(11.41f, 19.47f, 11.0f, 18.28f, 11.0f, 17.0f)
          curveTo(11.0f, 13.69f, 13.69f, 11.0f, 17.0f, 11.0f)
          close()
        }
        materialPath {
          moveTo(17.0f, 13.0f)
          curveToRelative(-2.21f, 0.0f, -4.0f, 1.79f, -4.0f, 4.0f)
          curveToRelative(0.0f, 2.21f, 1.79f, 4.0f, 4.0f, 4.0f)
          reflectiveCurveToRelative(4.0f, -1.79f, 4.0f, -4.0f)
          curveTo(21.0f, 14.79f, 19.21f, 13.0f, 17.0f, 13.0f)
          close()
          moveTo(17.0f, 14.38f)
          curveToRelative(0.62f, 0.0f, 1.12f, 0.51f, 1.12f, 1.12f)
          reflectiveCurveToRelative(-0.51f, 1.12f, -1.12f, 1.12f)
          reflectiveCurveToRelative(-1.12f, -0.51f, -1.12f, -1.12f)
          reflectiveCurveTo(16.38f, 14.38f, 17.0f, 14.38f)
          close()
          moveTo(17.0f, 19.75f)
          curveToRelative(-0.93f, 0.0f, -1.74f, -0.46f, -2.24f, -1.17f)
          curveToRelative(0.05f, -0.72f, 1.51f, -1.08f, 2.24f, -1.08f)
          reflectiveCurveToRelative(2.19f, 0.36f, 2.24f, 1.08f)
          curveTo(18.74f, 19.29f, 17.93f, 19.75f, 17.0f, 19.75f)
          close()
        }
      }
    return cachedAdminPanelSettings!!
  }

private var cachedAdminPanelSettings: ImageVector? = null
