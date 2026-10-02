import groovy.json.JsonSlurper
import org.gradle.api.tasks.Exec
import org.gradle.api.tasks.PathSensitivity
import java.io.File

abstract class GenerateGatewayProtocol : Exec() {
  @get:OutputDirectory
  abstract val outputDirectory: DirectoryProperty
}

plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.ktlint)
  alias(libs.plugins.kotlin.serialization)
}

val generateGatewayProtocol =
  tasks.register<GenerateGatewayProtocol>("generateGatewayProtocol") {
    val repositoryRoot = rootProject.projectDir.resolve("../..").canonicalFile
    val manifest = repositoryRoot.resolve("scripts/native-protocol-inputs.json")
    val protocolInputs = JsonSlurper().parse(manifest) as Map<*, *>
    val directories = protocolInputs["directories"] as List<*>
    val files = protocolInputs["files"] as List<*>
    inputs
      .files(
        directories.map { directory ->
          fileTree(repositoryRoot.resolve(directory as String)) {
            include("**/*.ts", "**/*.mts", "**/*.mjs", "**/*.json")
            exclude("**/node_modules/**", "**/*.test.*", "**/*.spec.*", "**/.*", "**/.*/**")
          }
        },
        files.map { file -> repositoryRoot.resolve(file as String) },
      ).withPathSensitivity(PathSensitivity.RELATIVE)
    outputDirectory.set(layout.buildDirectory.dir("generated/openclaw-protocol"))
    val nodeName = if (System.getProperty("os.name").startsWith("Windows")) "node.exe" else "node"
    val nodeCandidates =
      providers
        .environmentVariable("PATH")
        .orNull
        .orEmpty()
        .split(File.pathSeparator)
        .map { directory -> File(directory, nodeName) } +
        listOf(File("/opt/homebrew/bin/node"), File("/usr/local/bin/node"))
    val node =
      nodeCandidates.firstOrNull { it.isFile && it.canExecute() }
        ?: error("Node.js is required to build the Gateway protocol models.")
    workingDir(repositoryRoot)
    commandLine(
      node.absolutePath,
      repositoryRoot.resolve("scripts/prepare-native-protocol.mjs").path,
      "--language",
      "kotlin",
      "--out",
      outputDirectory.get().asFile.absolutePath,
    )
  }

androidComponents.onVariants { variant ->
  variant.sources.kotlin?.addGeneratedSourceDirectory(generateGatewayProtocol, GenerateGatewayProtocol::outputDirectory)
}

android {
  namespace = "ai.openclaw.gateway.client"
  compileSdk = 37

  defaultConfig {
    minSdk = 31
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  lint {
    warningsAsErrors = true
  }

  testOptions {
    unitTests.isIncludeAndroidResources = true
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    allWarningsAsErrors.set(true)
  }
}

ktlint {
  version.set(libs.versions.ktlint.cli)
  android.set(true)
  ignoreFailures.set(false)
  filter {
    exclude("**/build/**")
  }
}

dependencies {
  api(libs.kotlinx.coroutines.android)
  api(libs.kotlinx.serialization.json)
  api(libs.okhttp)
  implementation(libs.bcprov)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.mockwebserver)
  testImplementation(libs.robolectric)
}
