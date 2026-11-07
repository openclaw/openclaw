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

public val Icons.Filled.Pets: ImageVector
  get() {
    if (cachedPets != null) {
      return cachedPets!!
    }
    cachedPets =
      materialIcon(name = "Filled.Pets") {
        materialPath {
          moveTo(4.5f, 9.5f)
          moveToRelative(-2.5f, 0.0f)
          arcToRelative(2.5f, 2.5f, 0.0f, true, true, 5.0f, 0.0f)
          arcToRelative(2.5f, 2.5f, 0.0f, true, true, -5.0f, 0.0f)
        }
        materialPath {
          moveTo(9.0f, 5.5f)
          moveToRelative(-2.5f, 0.0f)
          arcToRelative(2.5f, 2.5f, 0.0f, true, true, 5.0f, 0.0f)
          arcToRelative(2.5f, 2.5f, 0.0f, true, true, -5.0f, 0.0f)
        }
        materialPath {
          moveTo(15.0f, 5.5f)
          moveToRelative(-2.5f, 0.0f)
          arcToRelative(2.5f, 2.5f, 0.0f, true, true, 5.0f, 0.0f)
          arcToRelative(2.5f, 2.5f, 0.0f, true, true, -5.0f, 0.0f)
        }
        materialPath {
          moveTo(19.5f, 9.5f)
          moveToRelative(-2.5f, 0.0f)
          arcToRelative(2.5f, 2.5f, 0.0f, true, true, 5.0f, 0.0f)
          arcToRelative(2.5f, 2.5f, 0.0f, true, true, -5.0f, 0.0f)
        }
        materialPath {
          moveTo(17.34f, 14.86f)
          curveToRelative(-0.87f, -1.02f, -1.6f, -1.89f, -2.48f, -2.91f)
          curveToRelative(-0.46f, -0.54f, -1.05f, -1.08f, -1.75f, -1.32f)
          curveToRelative(-0.11f, -0.04f, -0.22f, -0.07f, -0.33f, -0.09f)
          curveToRelative(-0.25f, -0.04f, -0.52f, -0.04f, -0.78f, -0.04f)
          reflectiveCurveToRelative(-0.53f, 0.0f, -0.79f, 0.05f)
          curveToRelative(-0.11f, 0.02f, -0.22f, 0.05f, -0.33f, 0.09f)
          curveToRelative(-0.7f, 0.24f, -1.28f, 0.78f, -1.75f, 1.32f)
          curveToRelative(-0.87f, 1.02f, -1.6f, 1.89f, -2.48f, 2.91f)
          curveToRelative(-1.31f, 1.31f, -2.92f, 2.76f, -2.62f, 4.79f)
          curveToRelative(0.29f, 1.02f, 1.02f, 2.03f, 2.33f, 2.32f)
          curveToRelative(0.73f, 0.15f, 3.06f, -0.44f, 5.54f, -0.44f)
          horizontalLineToRelative(0.18f)
          curveToRelative(2.48f, 0.0f, 4.81f, 0.58f, 5.54f, 0.44f)
          curveToRelative(1.31f, -0.29f, 2.04f, -1.31f, 2.33f, -2.32f)
          curveToRelative(0.31f, -2.04f, -1.3f, -3.49f, -2.61f, -4.8f)
          close()
        }
      }
    return cachedPets!!
  }

private var cachedPets: ImageVector? = null
