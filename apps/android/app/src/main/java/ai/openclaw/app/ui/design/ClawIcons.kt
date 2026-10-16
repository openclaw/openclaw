package ai.openclaw.app.ui.design

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

// Native counterparts of ui/src/components/icons.ts and icons-tools.ts. Keep the
// canonical paths and 24-unit, rounded 2-unit strokes aligned with the Web UI.
// Lucide/Feather notices: apps/android/THIRD_PARTY_LICENSES/openclaw/licenses/Lucide.txt.
internal object ClawIcons {
  val Settings: ImageVector by outline(
    "Settings",
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    "M15 12a3 3 0 1 0-6 0a3 3 0 1 0 6 0Z",
  )

  val Profile: ImageVector by outline(
    "CircleUser",
    "M18 20a6 6 0 0 0-12 0",
    "M16 10a4 4 0 1 0-8 0a4 4 0 1 0 8 0Z",
    "M22 12a10 10 0 1 0-20 0a10 10 0 1 0 20 0Z",
  )

  val Mic: ImageVector by outline("Mic", "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3")

  val Gateway: ImageVector by outline(
    "Radio",
    "M14 12a2 2 0 1 0-4 0a2 2 0 1 0 4 0Z",
    "M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14",
  )

  val Agents: ImageVector by outline(
    "Bot",
    "M12 8V4H8",
    "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z",
    "M2 14h2M20 14h2M15 13v2M9 13v2",
  )

  val Providers: ImageVector by outline(
    "Box",
    "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
    "M3.27 6.96 12 12.01 20.73 6.96M12 22.08V12",
  )

  val Approvals: ImageVector by outline(
    "BadgeCheck",
    "M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z",
    "m9 12 2 2 4-4",
  )

  val Automations: ImageVector by outline(
    "CalendarClock",
    "M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5",
    "M16 2v4M8 2v4M3 10h5M17.5 17.5 16 16.3V14",
    "M22 16a6 6 0 1 0-12 0a6 6 0 1 0 12 0Z",
  )

  val Usage: ImageVector by outline(
    "Coins",
    "M14 8a6 6 0 1 0-12 0a6 6 0 1 0 12 0Z",
    "M18.09 10.37A6 6 0 1 1 10.34 18",
    "M7 6h1v4",
    "m16.71 13.88.7.71-2.82 2.82",
  )

  val Skills: ImageVector by outline(
    "BookOpenText",
    "M12 5v16M16 13h2M16 9h2",
    "M20.001 19A2 2 0 0 0 22 17V5a2 2 0 0 0-1.999-2L16 3.002A5 5 0 0 0 12 5a5 5 0 0 0-4-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 1.999 2H8a5 5 0 0 1 4 2 5 5 0 0 1 4-2z",
    "M6 13h2M6 9h2",
  )

  val OpenClaw: ImageVector by lazy {
    ImageVector
      .Builder("OpenClaw", 24.dp, 24.dp, 120f, 120f)
      .apply {
        // Eye cutouts preserve the canonical mascot's face under a single tint.
        addPath(
          pathData =
            PathParser()
              .parsePathString(
                "M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z " +
                  "M51 35a6 6 0 1 0-12 0a6 6 0 1 0 12 0Z M81 35a6 6 0 1 0-12 0a6 6 0 1 0 12 0Z",
              ).toNodes(),
          fill = SolidColor(Color.Black),
          pathFillType = PathFillType.EvenOdd,
        )
        addPath(
          pathData =
            PathParser()
              .parsePathString(
                "M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z " +
                  "M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z " +
                  "M48.5 34a2.5 2.5 0 1 0-5 0a2.5 2.5 0 1 0 5 0Z M78.5 34a2.5 2.5 0 1 0-5 0a2.5 2.5 0 1 0 5 0Z",
              ).toNodes(),
          fill = SolidColor(Color.Black),
        )
        addPath(
          pathData = PathParser().parsePathString("M45 15Q35 5 30 8M75 15Q85 5 90 8").toNodes(),
          stroke = SolidColor(Color.Black),
          strokeLineWidth = 3f,
          strokeLineCap = StrokeCap.Round,
        )
      }.build()
  }

  val Devices: ImageVector by outline(
    "MonitorSmartphone",
    "M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8",
    "M10 19v-3.96 3.15M7 19h5",
    "M18 12h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z",
  )

  val Channels: ImageVector by outline(
    "Link",
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  )

  val Memory: ImageVector by outline("Book", "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20")

  val Terminal: ImageVector by outline("Terminal", "M4 17 10 11 4 5M12 19h8")

  val Desktop: ImageVector by outline(
    "Monitor",
    "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
    "M8 21h8M12 17v4",
  )

  val Notifications: ImageVector by outline(
    "Bell",
    "M10.268 21a2 2 0 0 0 3.464 0M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
  )

  val Permissions: ImageVector by outline("ShieldCheck", "M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3zM9 12l2 2 4-4")

  val Appearance: ImageVector by outline(
    "Palette",
    "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z",
    "M14 6.5a.5.5 0 1 0-1 0a.5.5 0 1 0 1 0Z M18 10.5a.5.5 0 1 0-1 0a.5.5 0 1 0 1 0Z " +
      "M7 12.5a.5.5 0 1 0-1 0a.5.5 0 1 0 1 0Z M9 7.5a.5.5 0 1 0-1 0a.5.5 0 1 0 1 0Z",
  )

  val Health: ImageVector by outline("Activity", "M22 12h-4l-3 9L9 3l-3 9H2")

  val About: ImageVector by outline(
    "FileText",
    "M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z",
    "M14 2v6h6M16 13H8M16 17H8M10 9H8",
  )

  val Licenses: ImageVector by outline(
    "ScrollText",
    "M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4",
    "M19 17V5a2 2 0 0 0-2-2H4M15 8h-5M15 12h-5",
  )

  val Overview: ImageVector by outline(
    "LayoutDashboard",
    "M4 3h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
    "M15 3h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
    "M15 12h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z",
    "M4 16h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z",
  )

  val Chat: ImageVector by outline("MessageSquare", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z")

  val Threads: ImageVector get() = About
}

private fun outline(
  name: String,
  vararg paths: String,
): Lazy<ImageVector> =
  lazy {
    ImageVector
      .Builder(name, 24.dp, 24.dp, 24f, 24f)
      .apply {
        paths.forEach { path ->
          addPath(
            pathData = PathParser().parsePathString(path).toNodes(),
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 2f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
          )
        }
      }.build()
  }
