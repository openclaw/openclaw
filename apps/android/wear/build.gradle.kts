plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.plugin.compose")
  id("org.jetbrains.kotlin.plugin.serialization")
}

android {
  namespace = "ai.openclaw.wear"
  compileSdk = 36

  defaultConfig {
    // Wear OS Data Layer messages are only delivered between paired apps
    // that share the same application ID and signing key.
    applicationId = "ai.openclaw.app"
    minSdk = 30
    targetSdk = 35
    versionCode = 1
    versionName = "2026.3.8"
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
    debug {
      isMinifyEnabled = false
    }
  }

  buildFeatures {
    compose = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  packaging {
    resources {
      excludes +=
        setOf(
          "/META-INF/{AL2.0,LGPL2.1}",
          "/META-INF/*.version",
          "/META-INF/LICENSE*.txt",
          "DebugProbesKt.bin",
          "kotlin-tooling-metadata.json",
        )
    }
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
  }
}

dependencies {
  val composeBom = platform("androidx.compose:compose-bom:2026.02.00")
  val tilesVersion = "1.6.0-rc02"
  val protolayoutVersion = "1.4.0-rc02"
  implementation(composeBom)

  // Wear OS
  implementation("androidx.wear.compose:compose-material3:1.5.6")
  implementation("androidx.wear.compose:compose-foundation:1.5.6")
  implementation("androidx.wear.compose:compose-navigation:1.5.6")

  // Core Compose
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.compose.material:material-icons-extended")
  debugImplementation("androidx.compose.ui:ui-tooling")

  // AndroidX
  implementation("androidx.activity:activity-compose:1.13.0")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.10.0")
  implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
  implementation("androidx.concurrent:concurrent-futures:1.3.0")

  // Networking + serialization
  implementation("com.squareup.okhttp3:okhttp:5.3.2")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.10.0")

  // Wear input (RemoteInput for text/voice entry)
  implementation("androidx.wear:wear-input:1.2.0")

  // Wear Data Layer (phone proxy)
  implementation("com.google.android.gms:play-services-wearable:19.0.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.10.2")

  // Complications
  implementation("androidx.wear.watchface:watchface-complications-data-source-ktx:1.3.0")

  // Tiles
  implementation("androidx.wear.tiles:tiles:$tilesVersion")
  implementation("androidx.wear.protolayout:protolayout:$protolayoutVersion")
  implementation("androidx.wear.protolayout:protolayout-material:$protolayoutVersion")
  implementation("androidx.wear.protolayout:protolayout-material3:$protolayoutVersion")
  implementation("androidx.wear.protolayout:protolayout-expression:$protolayoutVersion")

  // Tile Previews
  implementation("androidx.wear.tiles:tiles-tooling-preview:$tilesVersion")
  debugImplementation("androidx.wear.tiles:tiles-tooling:$tilesVersion")
  implementation("androidx.wear:wear-tooling-preview:1.0.0")

  testImplementation("junit:junit:4.13.2")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}
