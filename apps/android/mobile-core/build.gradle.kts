import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.plugin.mpp.apple.XCFramework

plugins {
  alias(libs.plugins.android.kotlin.multiplatform.library)
  alias(libs.plugins.kotlin.multiplatform)
  alias(libs.plugins.kotlin.serialization)
  id("co.touchlab.skie") version "0.10.13"
}

kotlin {
  android {
    namespace = "ai.openclaw.mobile.core"
    compileSdk = 37
    minSdk = 31

    compilerOptions {
      jvmTarget.set(JvmTarget.JVM_17)
    }
  }

  val framework = XCFramework("OpenClawMobileCore")
  listOf(
    iosArm64(),
    iosX64(),
    iosSimulatorArm64(),
    macosArm64(),
    macosX64(),
    watchosArm64(),
    watchosX64(),
    watchosSimulatorArm64(),
  ).forEach { target ->
    target.binaries.framework {
      baseName = "OpenClawMobileCore"
      isStatic = true
      framework.add(this)
    }
  }

  sourceSets {
    commonMain.dependencies {
      implementation(libs.kotlinx.serialization.json)
    }
  }
}

skie {
  analytics {
    enabled.set(false)
  }
}
